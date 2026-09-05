const express = require('express');
const router = express.Router();
const db = require('../config/db');
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs'); 

const upload = multer({ storage: multer.memoryStorage() });

// Drop constraint locally to accept all teacher roles
const dropTeacherConstraint = async () => {
    try { await db.query('ALTER TABLE teachers DROP CONSTRAINT IF EXISTS teachers_teacher_type_check;'); } catch (e) {}
};

const enforceBMUEmail = (email, name) => {
    if (!email) {
        if (!name) return '';
        let cleanName = name.replace(/^(Dr\.|Dr\s|Mr\.|Mr\s|Mrs\.|Mrs\s|Ms\.|Ms\s|Prof\.|Prof\s|Er\.|Er\s)+/ig, '').trim();
        const cleaned = cleanName.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '.').toLowerCase();
        return `${cleaned}@bmu.edu.in`;
    }
    const emailPrefix = email.split('@')[0].trim().replace(/\s+/g, '.').toLowerCase();
    return `${emailPrefix}@bmu.edu.in`;
};

router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT 
                t.id, t.full_name, t.email, t.teacher_type,
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
    await dropTeacherConstraint();
    let { full_name, email, teacher_type } = req.body;
    email = enforceBMUEmail(email, full_name);
    const username = email.split('@')[0];

    try {
        const salt = await bcrypt.genSalt(6);
        const hashedPassword = await bcrypt.hash('password123', salt);

        const { rows } = await db.query(
            'INSERT INTO teachers (username, password, full_name, email, teacher_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [username, hashedPassword, full_name, email, teacher_type || 'Assistant Prof.']
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
    await dropTeacherConstraint();
    const { id } = req.params;
    let { full_name, email, teacher_type } = req.body;
    email = enforceBMUEmail(email, full_name);

    try {
        const { rows } = await db.query(
            'UPDATE teachers SET full_name = $1, email = $2, teacher_type = $3 WHERE id = $4 RETURNING *',
            [full_name, email, teacher_type, id]
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
        res.json({ courses: courses.rows, sections: timetables.rows });
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching allocation options' });
    }
});

router.post('/upload-preview', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No Excel file provided' });

    try {
        // Fetch full existing teacher details to match by either Email OR Full Name
        const existingRes = await db.query('SELECT id, full_name, email, teacher_type FROM teachers');
        const existingTeachers = existingRes.rows;

        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        const parsedTeachers = new Map();
        let totalUpdates = 0;
        let totalEmailUpdates = 0;

        rawData.forEach(row => {
            // Robust parsing of potential Excel Column Headers
            const fName = (row.FacultyName || row['Faculty Name'] || row.Name || row['Full Name'] || row.Teacher || row.Faculty || '')?.toString().trim();
            const fType = (row.Type || row.TeacherType || row.Role || row.Designation || 'Assistant Prof.')?.toString().trim();
            if (!fName) return; 

            let providedEmail = (row.FacultyEmail || row.Email || row['Email Address'] || row['Email ID'] || '')?.toString().trim();
            let fEmail = enforceBMUEmail(providedEmail, fName);

            let isUpdate = false;
            let updateDetails = [];

            // Find matching teacher by EXACT Name OR EXACT Email (case insensitive)
            const match = existingTeachers.find(t => 
                t.email.toLowerCase() === fEmail.toLowerCase() || 
                t.full_name.toLowerCase() === fName.toLowerCase()
            );

            if (match) {
                isUpdate = true;
                
                // Track specifically what is updating
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
            }

            if (isUpdate && !parsedTeachers.has(fEmail)) {
                totalUpdates++;
            }

            parsedTeachers.set(fEmail, { 
                full_name: fName, 
                email: fEmail, 
                teacher_type: fType, 
                is_update: isUpdate,
                update_details: updateDetails
            });
        });

        res.json({ 
            overwrites: { total_updates: totalUpdates, email_updates: totalEmailUpdates }, 
            preview: { teachers: Array.from(parsedTeachers.values()) } 
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to process Excel file. Ensure it is a valid format.' });
    }
});

router.post('/commit-upload', async (req, res) => {
    const { teachers } = req.body;
    if (!teachers || !Array.isArray(teachers)) return res.status(400).json({ error: 'Invalid teacher data provided' });

    await dropTeacherConstraint();

    try {
        await db.query('BEGIN');
        const uniqueTeachersMap = {};
        
        // Clean and prepare the incoming dataset
        for (const t of teachers) {
            if (!t.full_name) continue;
            const enforcedEmail = enforceBMUEmail(t.email, t.full_name);
            if (!uniqueTeachersMap[enforcedEmail]) {
                uniqueTeachersMap[enforcedEmail] = { ...t, email: enforcedEmail };
            }
        }

        const salt = await bcrypt.genSalt(6);
        const defaultPassword = await bcrypt.hash('password123', salt);

        for (const t of Object.values(uniqueTeachersMap)) {
            const username = t.email.split('@')[0];
            
            // Match against Database (Name OR Email allows updating email addresses correctly)
            let tRes = await db.query(
                'SELECT id FROM teachers WHERE LOWER(email) = $1 OR LOWER(full_name) = $2', 
                [t.email.toLowerCase(), t.full_name.toLowerCase()]
            );
            
            if (tRes.rows.length > 0) {
                // Perform Update (including email & username in case they were updated via Excel)
                try {
                    await db.query(
                        'UPDATE teachers SET full_name = $1, email = $2, username = $3, teacher_type = $4 WHERE id = $5', 
                        [t.full_name, t.email, username, t.teacher_type, tRes.rows[0].id]
                    );
                } catch(e) {
                    console.error("Error updating existing teacher details:", e);
                }
            } else {
                // Perform Insert
                try {
                    await db.query('INSERT INTO teachers (username, password, full_name, email, teacher_type) VALUES ($1, $2, $3, $4, $5)', 
                    [username, defaultPassword, t.full_name, t.email, t.teacher_type || 'Assistant Prof.']);
                } catch (err) {
                    // Conflict fallback (Usually hits if there's a unique username conflict but the name didn't match perfectly)
                    if (err.code === '23505') {
                        let fallbackRes = await db.query('SELECT id FROM teachers WHERE LOWER(username) = $1', [username]);
                        if(fallbackRes.rows.length > 0) {
                            try { 
                                await db.query('UPDATE teachers SET full_name = $1, email = $2, teacher_type = $3 WHERE id = $4', 
                                [t.full_name, t.email, t.teacher_type, fallbackRes.rows[0].id]); 
                            } catch(e){}
                        }
                    } else throw err;
                }
            }
        }

        await db.query('COMMIT');
        res.json({ message: 'Teachers imported successfully from Excel.' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: err.detail || err.message || 'Failed to save changes to database' });
    }
});

module.exports = router;