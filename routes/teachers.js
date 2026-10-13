const express = require('express');
const router = express.Router();
const db = require('../config/db');
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');

const upload = multer({ storage: multer.memoryStorage() });

// Canonical roles supported across Faculty, Lab Staff, and PhD Scholars
const CANONICAL_ROLES = [
    'Professor',
    'Associate Professor',
    'Assistant Professor - I',
    'Assistant Professor - II',
    'Assistant Professor - III',
    'Assistant Professor',
    'Professor of Practice',
    'Adjunct Industry Professor',
    'Faculty Associate',
    'Visiting Faculty',
    'Coding Skill Faculty',
    'Lab Superintendent',
    'Senior Lab Technician',
    'Lab Supervisor',
    'Lab Technician',
    'Lab Assistant',
    'Engineer',
    'PhD Scholar'
];

// Ensure database schema supports all roles, departments, and contact numbers
const ensureTeacherSchema = async () => {
    try {
        await db.query('ALTER TABLE teachers DROP CONSTRAINT IF EXISTS teachers_teacher_type_check;');
        await db.query('ALTER TABLE teachers ADD COLUMN IF NOT EXISTS department VARCHAR(255);');
        await db.query('ALTER TABLE teachers ADD COLUMN IF NOT EXISTS contact_no VARCHAR(255);');
    } catch (e) {
        console.warn('Schema check warning:', e.message);
    }
};

// Clean Honorifics & Format BMU Email
const enforceBMUEmail = (email, name) => {
    if (!email || !email.toString().trim()) {
        if (!name) return '';
        let cleanName = name
            .toString()
            .replace(/^(Dr\.|Dr\s|Mr\.|Mr\s|Mrs\.|Mrs\s|Ms\.|Ms\s|Prof\.|Prof\s|Er\.|Er\s|Shri\.|Shri\s|Smt\.|Smt\s)+/ig, '')
            .trim();
        const cleaned = cleanName
            .replace(/[^a-zA-Z0-9\s]/g, ' ')
            .trim()
            .replace(/\s+/g, '.')
            .replace(/\.+/g, '.')
            .replace(/^\.|\.$|/g, '')
            .toLowerCase();
        return cleaned ? `${cleaned}@bmu.edu.in` : '';
    }
    const emailPrefix = email
        .toString()
        .split('@')[0]
        .trim()
        .replace(/\s+/g, '.')
        .replace(/\.+/g, '.')
        .replace(/^\.|\.$|/g, '')
        .toLowerCase();
    return emailPrefix ? `${emailPrefix}@bmu.edu.in` : '';
};

// Normalize and validate contact numbers (supports single or slash/comma-separated numbers)
const normalizeContactNo = (rawContact) => {
    if (rawContact === undefined || rawContact === null) return { value: '', valid: true, warning: null };
    const rawStr = rawContact.toString().trim();
    if (!rawStr) return { value: '', valid: true, warning: null };

    const parts = rawStr
        .split(/[\/,;]+/)
        .map(p => p.replace(/[^0-9+]/g, '').trim())
        .filter(Boolean);

    if (parts.length === 0) {
        return { value: '', valid: false, warning: `Invalid contact number: "${rawStr}"` };
    }

    const invalidParts = parts.filter(p => {
        const digits = p.replace(/^\+?91/, '');
        return digits.length < 10 || digits.length > 12;
    });

    return {
        value: parts.join(' / '),
        valid: invalidParts.length === 0,
        warning: invalidParts.length > 0 ? `Unusual phone length in: ${invalidParts.join(', ')}` : null
    };
};

// Normalize Designation / Role and infer from Department or Sheet Context when missing
const normalizeRoleAndDepartment = (rawRole, rawDept, sheetContext = '') => {
    const warnings = [];
    let dept = (rawDept || '').toString().trim();
    let roleInput = (rawRole || '').toString().trim();
    const upperRole = roleInput.toUpperCase().replace(/\s+/g, ' ');
    const upperDept = dept.toUpperCase().replace(/\s+/g, ' ');
    const upperCtx = (sheetContext || '').toUpperCase();

    // Infer department if missing and sheet context mentions SOET / PhD
    if (!dept && (upperCtx.includes('SOET') || upperCtx.includes('PHD'))) {
        const matchParen = sheetContext.match(/\(([^)]+)\)/);
        dept = matchParen ? matchParen[1].trim() : 'SOET';
    }

    let normalizedRole = '';

    if (!roleInput) {
        if (upperDept === 'VF' || upperDept.includes('VISITING')) {
            normalizedRole = 'Visiting Faculty';
            warnings.push('Role auto-inferred as "Visiting Faculty" from Department (VF)');
        } else if (upperDept.includes('CODING SKILL')) {
            normalizedRole = 'Coding Skill Faculty';
            warnings.push('Role auto-inferred as "Coding Skill Faculty" from Department');
        } else if (upperCtx.includes('PHD') || upperCtx.includes('SCHOLAR')) {
            normalizedRole = 'PhD Scholar';
            warnings.push('Role auto-inferred as "PhD Scholar" from sheet header');
        } else if (upperDept.includes('LAB')) {
            normalizedRole = 'Lab Technician';
            warnings.push('Role auto-inferred as "Lab Technician" from Lab Department');
        } else {
            normalizedRole = 'Assistant Professor';
            warnings.push('Missing designation defaulted to "Assistant Professor"');
        }
        return { role: normalizedRole, department: dept, warnings };
    }

    // Match Assistant Professor tiers (handles "Assistant Professor-I", "Assistant Professor - II", etc.)
    if (/ASSISTANT\s*PROF(ESSOR|\.)?\s*[-–]?\s*III\b/i.test(upperRole)) {
        normalizedRole = 'Assistant Professor - III';
    } else if (/ASSISTANT\s*PROF(ESSOR|\.)?\s*[-–]?\s*II\b/i.test(upperRole)) {
        normalizedRole = 'Assistant Professor - II';
    } else if (/ASSISTANT\s*PROF(ESSOR|\.)?\s*[-–]?\s*I\b/i.test(upperRole)) {
        normalizedRole = 'Assistant Professor - I';
    } else if (/ASSISTANT\s*PROF/i.test(upperRole)) {
        normalizedRole = 'Assistant Professor';
    } else if (/ASSOCIATE\s*PROF/i.test(upperRole)) {
        normalizedRole = 'Associate Professor';
    } else if (/PROF(ESSOR|\.)?\s*OF\s*PRACTICE/i.test(upperRole)) {
        normalizedRole = 'Professor of Practice';
    } else if (/ADJUNCT\s*INDUSTRY\s*PROF/i.test(upperRole)) {
        normalizedRole = 'Adjunct Industry Professor';
    } else if (/^PROF(ESSOR|\.)?$/i.test(upperRole)) {
        normalizedRole = 'Professor';
    } else if (/FACULTY\s*ASSOCIATE/i.test(upperRole)) {
        normalizedRole = 'Faculty Associate';
    } else if (/VISITING\s*FACULTY|^VF$/i.test(upperRole)) {
        normalizedRole = 'Visiting Faculty';
    } else if (/CODING\s*SKILL/i.test(upperRole)) {
        normalizedRole = 'Coding Skill Faculty';
    } else if (/LAB\s*SUPERINTEND/i.test(upperRole)) {
        // Handles "LAB SUPERINTENDENT" and truncated "LAB SUPERINTENDEN"
        normalizedRole = 'Lab Superintendent';
    } else if (/SENI+OR\s*LAB\s*TECH/i.test(upperRole) || /SR\.?\s*LAB\s*TECH/i.test(upperRole)) {
        // Handles "SENIOR LAB TECHNICIAN", typo "SENIIOR LAB TECHNICIAN", and truncated "SENIOR LAB TECHNIC"
        normalizedRole = 'Senior Lab Technician';
    } else if (/LAB\s*SUPERVISOR/i.test(upperRole)) {
        // Handles "LAB SUPERVISOR" and "LAB SUPERVISOR (LE...)"
        normalizedRole = 'Lab Supervisor';
    } else if (/LAB\s*TECH/i.test(upperRole)) {
        normalizedRole = 'Lab Technician';
    } else if (/LAB\s*ASSISTANT/i.test(upperRole)) {
        normalizedRole = 'Lab Assistant';
    } else if (/ENGINEER/i.test(upperRole)) {
        normalizedRole = 'Engineer';
    } else if (/PH\.?D|SCHOLAR/i.test(upperRole)) {
        normalizedRole = 'PhD Scholar';
    } else {
        // Fallback: Title Case the custom designation
        normalizedRole = roleInput
            .toLowerCase()
            .replace(/\b\w/g, c => c.toUpperCase());
        warnings.push(`Unrecognized designation "${roleInput}" kept as "${normalizedRole}"`);
    }

    if (normalizedRole.toLowerCase() !== roleInput.toLowerCase()) {
        warnings.push(`Normalized designation "${roleInput}" ➔ "${normalizedRole}"`);
    }

    return { role: normalizedRole, department: dept, warnings };
};

// Parse worksheet supporting both standard header rows and banner title rows (e.g., "Full-Time PhD Scholars (SOET)")
const extractSheetRowsWithContext = (worksheet, sheetName) => {
    const matrix = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    if (!matrix || matrix.length === 0) return { rows: [], contextTitle: sheetName };

    let headerRowIndex = 0;
    let contextTitle = sheetName || '';

    const knownHeaderPattern = /^(employee\s*name|faculty\s*name|faculty|name|full\s*name|s\.?\s*no\.?|sr\.?\s*no\.?|contact\s*no\.?|designation|department|email\s*id|email)$/i;

    for (let r = 0; r < Math.min(matrix.length, 5); r++) {
        const nonEmptyCells = matrix[r].map(c => c?.toString().trim()).filter(Boolean);
        if (nonEmptyCells.length === 0) continue;

        const matchesHeader = nonEmptyCells.some(cell => knownHeaderPattern.test(cell));
        if (matchesHeader) {
            headerRowIndex = r;
            break;
        } else if (nonEmptyCells.length === 1 && r === 0) {
            // Single merged banner title in Row 0 (like "Full-Time PhD Scholars (SOET)")
            contextTitle = `${contextTitle} ${nonEmptyCells[0]}`.trim();
        }
    }

    const headers = (matrix[headerRowIndex] || []).map((h, idx) =>
        h ? h.toString().trim() : `COL_${idx}`
    );

    const rows = [];
    for (let r = headerRowIndex + 1; r < matrix.length; r++) {
        const rowCells = matrix[r];
        if (!rowCells || rowCells.every(c => !c || !c.toString().trim())) continue;
        const obj = {};
        headers.forEach((h, idx) => {
            obj[h] = rowCells[idx] !== undefined ? rowCells[idx] : '';
        });
        rows.push(obj);
    }

    return { rows, contextTitle };
};

router.get('/', async (req, res) => {
    await ensureTeacherSchema();
    try {
        const query = `
            SELECT 
                t.id, t.full_name, t.email, t.teacher_type,
                COALESCE(t.department, '') as department,
                COALESCE(t.contact_no, '') as contact_no,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'course_code', c.course_code,
                            'course_title', c.course_title,
                            'stream', tb.stream,
                            'semester', tb.semester,
                            'batch', tb.batch_year
                        )
                    ) FILTER (WHERE c.id IS NOT NULL), '[]'
                ) as allocations
            FROM teachers t
            LEFT JOIN timetable_course_teachers tct ON t.id = tct.teacher_id
            LEFT JOIN courses c ON tct.course_id = c.id
            LEFT JOIN timetables tb ON tct.timetable_id = tb.id
            GROUP BY t.id
            ORDER BY t.full_name ASC
        `;
        const { rows } = await db.query(query);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching teachers' });
    }
});

router.post('/', async (req, res) => {
    await ensureTeacherSchema();
    let { full_name, email, teacher_type, department, contact_no } = req.body;

    if (!full_name || !full_name.toString().trim()) {
        return res.status(400).json({ error: 'Full name is required.' });
    }

    full_name = full_name.toString().trim();
    const { role, department: normDept } = normalizeRoleAndDepartment(teacher_type, department);
    const contactResult = normalizeContactNo(contact_no);
    if (!contactResult.valid) {
        return res.status(400).json({ error: contactResult.warning });
    }

    email = enforceBMUEmail(email, full_name);
    const username = email.split('@')[0];

    try {
        const salt = await bcrypt.genSalt(6);
        const hashedPassword = await bcrypt.hash('password123', salt);

        const { rows } = await db.query(
            `INSERT INTO teachers (username, password, full_name, email, teacher_type, department, contact_no)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [username, hashedPassword, full_name, email, role, normDept, contactResult.value]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Teacher with this name or email already exists.' });
        }
        res.status(500).json({ error: 'Server error adding teacher' });
    }
});

router.put('/:id', async (req, res) => {
    await ensureTeacherSchema();
    const { id } = req.params;
    let { full_name, email, teacher_type, department, contact_no } = req.body;

    if (!full_name || !full_name.toString().trim()) {
        return res.status(400).json({ error: 'Full name is required.' });
    }

    full_name = full_name.toString().trim();
    const { role, department: normDept } = normalizeRoleAndDepartment(teacher_type, department);
    const contactResult = normalizeContactNo(contact_no);
    if (!contactResult.valid) {
        return res.status(400).json({ error: contactResult.warning });
    }

    email = enforceBMUEmail(email, full_name);

    try {
        const { rows } = await db.query(
            `UPDATE teachers
             SET full_name = $1, email = $2, teacher_type = $3, department = $4, contact_no = $5
             WHERE id = $6 RETURNING *`,
            [full_name, email, role, normDept, contactResult.value, id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Teacher not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error updating teacher' });
    }
});

router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('BEGIN');
        await db.query('DELETE FROM timetable_course_teachers WHERE teacher_id = $1', [id]);
        await db.query('DELETE FROM teachers WHERE id = $1', [id]);
        await db.query('COMMIT');
        res.json({ message: 'Teacher deleted successfully' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: 'Server error deleting teacher' });
    }
});

router.get('/:id/allocations', async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await db.query(`
            SELECT 
                tct.course_id, tct.timetable_id, c.course_title, c.course_code, 
                CONCAT(t.stream, ' - Sem ', t.semester, ' (', t.batch_year, ')') as timetable_name
            FROM timetable_course_teachers tct
            JOIN courses c ON tct.course_id = c.id
            JOIN timetables t ON tct.timetable_id = t.id
            WHERE tct.teacher_id = $1
        `, [id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching allocations' });
    }
});

router.post('/:id/allocations', async (req, res) => {
    const { id } = req.params;
    const { allocations } = req.body;

    try {
        await db.query('BEGIN');
        await db.query('DELETE FROM timetable_course_teachers WHERE teacher_id = $1', [id]);

        if (allocations && allocations.length > 0) {
            for (let alloc of allocations) {
                if (alloc.course_id && alloc.timetable_id) {
                    await db.query(
                        'INSERT INTO timetable_course_teachers (teacher_id, course_id, timetable_id) VALUES ($1, $2, $3)',
                        [id, alloc.course_id, alloc.timetable_id]
                    );
                }
            }
        }
        await db.query('COMMIT');
        res.json({ message: 'Allocations updated successfully' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: 'Server error updating allocations' });
    }
});

router.get('/data/options', async (req, res) => {
    try {
        const courses = await db.query('SELECT id, course_title, course_code FROM courses ORDER BY course_title ASC');
        const timetables = await db.query(`SELECT id, CONCAT(stream, ' - Sem ', semester, ' (', batch_year, ')') as name FROM timetables ORDER BY batch_year DESC, stream ASC, semester ASC`);
        res.json({ courses: courses.rows, sections: timetables.rows, roles: CANONICAL_ROLES });
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching allocation options' });
    }
});

// Helper to lookup object keys case-insensitively
const getRowField = (row, candidateKeys) => {
    const keys = Object.keys(row);
    for (const candidate of candidateKeys) {
        const foundKey = keys.find(k => k.trim().toLowerCase() === candidate.toLowerCase());
        if (foundKey !== undefined && row[foundKey] !== undefined && row[foundKey] !== null) {
            const val = row[foundKey].toString().trim();
            if (val !== '') return val;
        }
    }
    return '';
};

router.post('/upload-preview', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No Excel file provided' });

    await ensureTeacherSchema();

    try {
        const existingRes = await db.query(
            'SELECT id, full_name, email, teacher_type, COALESCE(department, \'\') as department, COALESCE(contact_no, \'\') as contact_no FROM teachers'
        );
        const existingTeachers = existingRes.rows;

        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });

        const parsedTeachers = new Map();
        let totalUpdates = 0;
        let totalEmailUpdates = 0;
        let totalWarnings = 0;

        for (const sheetName of workbook.SheetNames) {
            const worksheet = workbook.Sheets[sheetName];
            const { rows: rawData, contextTitle } = extractSheetRowsWithContext(worksheet, sheetName);

            // Check if sheet only has S.No + Name columns (like Full-Time PhD Scholars sheet)
            const firstRowKeys = rawData.length > 0 ? Object.keys(rawData[0]).map(k => k.toLowerCase()) : [];
            const isPhDScholarSheet =
                /phd|scholar/i.test(contextTitle) ||
                (firstRowKeys.some(k => k.includes('s.no') || k.includes('sno')) &&
                    firstRowKeys.some(k => k === 'name') &&
                    !firstRowKeys.some(k => k.includes('designation') || k.includes('role') || k.includes('type')));

            rawData.forEach((row) => {
                const fName = getRowField(row, [
                    'Employee Name',
                    'EmployeeName',
                    'Faculty',
                    'Faculty Name',
                    'FacultyName',
                    'Name',
                    'Full Name',
                    'FullName',
                    'Teacher',
                    'Scholar Name'
                ]);

                // Skip empty or repeated header rows
                if (!fName || /^(employee\s*name|faculty|name|full\s*name|s\.?no\.?)$/i.test(fName)) return;

                const rawRole = getRowField(row, [
                    'Designation',
                    'Role',
                    'Type',
                    'TeacherType',
                    'Teacher Type',
                    'Position'
                ]);

                const rawDept = getRowField(row, [
                    'Department',
                    'Dept',
                    'School',
                    'Stream',
                    'Branch'
                ]);

                const rawContact = getRowField(row, [
                    'Contact No.',
                    'Contact No',
                    'Contact',
                    'Phone',
                    'Phone No.',
                    'Mobile',
                    'Mobile No.'
                ]);

                const providedEmail = getRowField(row, [
                    'EmailID',
                    'Email ID',
                    'Email',
                    'FacultyEmail',
                    'Email Address',
                    'Official Email'
                ]);

                const effectiveContext = isPhDScholarSheet ? `${contextTitle} PhD Scholar SOET` : contextTitle;
                const { role: fType, department: fDept, warnings: roleWarnings } = normalizeRoleAndDepartment(
                    rawRole,
                    rawDept,
                    effectiveContext
                );

                const contactCheck = normalizeContactNo(rawContact);
                const validationWarnings = [...roleWarnings];
                if (contactCheck.warning) validationWarnings.push(contactCheck.warning);
                if (!providedEmail) {
                    validationWarnings.push('Email auto-generated from name');
                }

                let fEmail = enforceBMUEmail(providedEmail, fName);

                // Avoid silent overwrite if two distinct people in the same sheet generate the same email
                if (parsedTeachers.has(fEmail)) {
                    const existingEntry = parsedTeachers.get(fEmail);
                    if (existingEntry.full_name.toLowerCase() !== fName.toLowerCase()) {
                        const [prefix, domain] = fEmail.split('@');
                        const deptSlug = fDept ? fDept.toLowerCase().replace(/[^a-z0-9]/g, '') : '2';
                        fEmail = `${prefix}.${deptSlug || '2'}@${domain}`;
                        validationWarnings.push(`Disambiguated duplicate generated email to ${fEmail}`);
                    }
                }

                let isUpdate = false;
                let updateDetails = [];

                const match = existingTeachers.find(
                    t =>
                        (t.email && t.email.toLowerCase() === fEmail.toLowerCase()) ||
                        (t.full_name && t.full_name.toLowerCase() === fName.toLowerCase())
                );

                if (match) {
                    isUpdate = true;
                    if (match.email.toLowerCase() !== fEmail.toLowerCase()) {
                        updateDetails.push(`Email: ${match.email} ➔ ${fEmail}`);
                        if (!parsedTeachers.has(fEmail)) totalEmailUpdates++;
                    }
                    if (match.full_name !== fName) {
                        updateDetails.push(`Name: ${match.full_name} ➔ ${fName}`);
                    }
                    if (match.teacher_type !== fType) {
                        updateDetails.push(`Role: ${match.teacher_type} ➔ ${fType}`);
                    }
                    if (fDept && (match.department || '') !== fDept) {
                        updateDetails.push(`Dept: ${match.department || 'None'} ➔ ${fDept}`);
                    }
                    if (contactCheck.value && (match.contact_no || '') !== contactCheck.value) {
                        updateDetails.push(`Contact: ${match.contact_no || 'None'} ➔ ${contactCheck.value}`);
                    }
                }

                if (isUpdate && !parsedTeachers.has(fEmail)) {
                    totalUpdates++;
                }
                if (validationWarnings.length > 0 && !parsedTeachers.has(fEmail)) {
                    totalWarnings++;
                }

                parsedTeachers.set(fEmail, {
                    full_name: fName,
                    email: fEmail,
                    teacher_type: fType,
                    department: fDept,
                    contact_no: contactCheck.value,
                    is_update: isUpdate,
                    update_details: updateDetails,
                    validation_warnings: validationWarnings,
                    sheet_source: sheetName
                });
            });
        }

        res.json({
            overwrites: {
                total_updates: totalUpdates,
                email_updates: totalEmailUpdates,
                total_warnings: totalWarnings
            },
            preview: { teachers: Array.from(parsedTeachers.values()) }
        });
    } catch (err) {
        console.error('Excel preview error:', err);
        res.status(500).json({ error: 'Failed to process Excel file. Ensure it is a valid format.' });
    }
});

router.post('/commit-upload', async (req, res) => {
    const { teachers } = req.body;
    if (!teachers || !Array.isArray(teachers)) {
        return res.status(400).json({ error: 'Invalid teacher data provided' });
    }

    await ensureTeacherSchema();

    try {
        await db.query('BEGIN');
        const uniqueTeachersMap = {};

        for (const t of teachers) {
            if (!t.full_name || !t.full_name.toString().trim()) continue;
            const cleanName = t.full_name.toString().trim();
            const enforcedEmail = enforceBMUEmail(t.email, cleanName);
            const { role, department } = normalizeRoleAndDepartment(t.teacher_type, t.department);
            const contactResult = normalizeContactNo(t.contact_no);

            if (!uniqueTeachersMap[enforcedEmail]) {
                uniqueTeachersMap[enforcedEmail] = {
                    full_name: cleanName,
                    email: enforcedEmail,
                    teacher_type: role,
                    department: department || '',
                    contact_no: contactResult.value || ''
                };
            }
        }

        const salt = await bcrypt.genSalt(6);
        const defaultPassword = await bcrypt.hash('password123', salt);

        for (const t of Object.values(uniqueTeachersMap)) {
            const username = t.email.split('@')[0];

            let tRes = await db.query(
                'SELECT id, department, contact_no FROM teachers WHERE LOWER(email) = $1 OR LOWER(full_name) = $2',
                [t.email.toLowerCase(), t.full_name.toLowerCase()]
            );

            if (tRes.rows.length > 0) {
                const existingRow = tRes.rows[0];
                const finalDept = t.department || existingRow.department || '';
                const finalContact = t.contact_no || existingRow.contact_no || '';
                try {
                    await db.query(
                        `UPDATE teachers
                         SET full_name = $1, email = $2, username = $3, teacher_type = $4, department = $5, contact_no = $6
                         WHERE id = $7`,
                        [t.full_name, t.email, username, t.teacher_type, finalDept, finalContact, existingRow.id]
                    );
                } catch (e) {
                    console.error('Error updating existing teacher details:', e);
                }
            } else {
                try {
                    await db.query(
                        `INSERT INTO teachers (username, password, full_name, email, teacher_type, department, contact_no)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [username, defaultPassword, t.full_name, t.email, t.teacher_type || 'Assistant Professor', t.department || '', t.contact_no || '']
                    );
                } catch (err) {
                    if (err.code === '23505') {
                        let fallbackRes = await db.query('SELECT id FROM teachers WHERE LOWER(username) = $1', [username]);
                        if (fallbackRes.rows.length > 0) {
                            try {
                                await db.query(
                                    `UPDATE teachers
                                     SET full_name = $1, email = $2, teacher_type = $3, department = $4, contact_no = $5
                                     WHERE id = $6`,
                                    [t.full_name, t.email, t.teacher_type, t.department || '', t.contact_no || '', fallbackRes.rows[0].id]
                                );
                            } catch (e) {}
                        }
                    } else throw err;
                }
            }
        }

        await db.query('COMMIT');
        res.json({ message: 'Teachers and staff imported successfully from Excel.' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: err.detail || err.message || 'Failed to save changes to database' });
    }
});

module.exports = router;