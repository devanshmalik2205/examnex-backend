const express = require('express');
const router = express.Router();
const db = require('../config/db');
const multer = require('multer');
const xlsx = require('xlsx');

// Use memory storage for processing the file immediately
const upload = multer({ storage: multer.memoryStorage() });

// Helper function to clean names (Remove Dr., Mr., etc.)
const cleanTeacherName = (name) => {
    if (!name) return '';
    let cleaned = name.trim();
    cleaned = cleaned.replace(/^(With\s+|And\s+)/i, '');
    const prefixRegex = /^(Dr\.|Dr\s|Mr\.|Mr\s|Mrs\.|Mrs\s|Ms\.|Ms\s|Prof\.|Prof\s|Er\.|Er\s)+/i;
    while (prefixRegex.test(cleaned)) {
        cleaned = cleaned.replace(prefixRegex, '').trim();
    }
    return cleaned;
};

// Helper to split multiple teachers in a single cell
const parseTeachersList = (rawString) => {
    if (!rawString) return [];
    const parts = rawString.split(/\s+and\s+|\s*&\s*|\s*\/\s*|,/i);
    return parts.map(p => cleanTeacherName(p)).filter(p => p.length > 0);
};

// Helper to parse time headers like "9:00 AM - 9:55 AM" or "10:00 AM- 10:55 AM"
const parseTimeHeader = (str) => {
    const match = str.match(/(\d{1,2}:\d{2})\s*([AP]M)?\s*-\s*(\d{1,2}:\d{2})\s*([AP]M)?/i);
    if (!match) return null;
    
    let [_, startT, startM, endT, endM] = match;
    if (!startM) startM = endM; 
    
    const to24 = (time, mod) => {
        let [h, m] = time.split(':');
        h = parseInt(h, 10);
        if (mod && mod.toUpperCase() === 'PM' && h !== 12) h += 12;
        if (mod && mod.toUpperCase() === 'AM' && h === 12) h = 0;
        return `${h.toString().padStart(2, '0')}:${m}:00`;
    };
    
    try {
        return { start: to24(startT, startM), end: to24(endT, endM) };
    } catch(e) { return null; }
};

// --- Standard Routes ---
router.get('/stats', async (req, res) => {
    try {
        const examsResult = await db.query('SELECT COUNT(DISTINCT course_id) as total FROM timetable_entries');
        const studentsResult = await db.query('SELECT COUNT(*) as total FROM students');
        const roomsResult = await db.query('SELECT COUNT(DISTINCT room) as total FROM timetable_entries WHERE room IS NOT NULL');
        
        const clashesResult = await db.query(`
            SELECT COUNT(*) as total 
            FROM timetable_entries t1
            JOIN timetable_entries t2 ON t1.room = t2.room AND t1.day_of_week = t2.day_of_week AND t1.id != t2.id
            WHERE t1.start_time < t2.end_time AND t1.end_time > t2.start_time
        `);

        res.json({
            total_exams: parseInt(examsResult.rows[0].total) || 0,
            total_students: parseInt(studentsResult.rows[0].total) || 0,
            total_rooms: parseInt(roomsResult.rows[0].total) || 0,
            conflicts: Math.floor((parseInt(clashesResult.rows[0].total) || 0) / 2)
        });
    } catch (err) {
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

router.get('/timetables', async (req, res) => {
    try {
        const query = `SELECT id, batch_year, stream, semester, source_sheet FROM timetables ORDER BY batch_year DESC, stream ASC, semester ASC;`;
        const { rows } = await db.query(query);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

router.post('/timetables', async (req, res) => {
    const { batch_year, stream, semester } = req.body;
    try {
        const { rows } = await db.query(
            'INSERT INTO timetables (batch_year, stream, semester) VALUES ($1, $2, $3) RETURNING *',
            [batch_year, stream, semester]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'This specific Batch, Stream, and Semester combination already exists.' });
        res.status(500).json({ error: 'Failed to create section.' });
    }
});

router.delete('/timetables/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('BEGIN');
        await db.query('DELETE FROM timetable_entries WHERE timetable_id = $1', [id]);
        await db.query('DELETE FROM timetable_course_teachers WHERE timetable_id = $1', [id]);
        await db.query('DELETE FROM student_timetable WHERE timetable_id = $1', [id]);
        await db.query('DELETE FROM timetables WHERE id = $1', [id]);
        await db.query('COMMIT');
        res.json({ message: 'Section deleted successfully.' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to delete section.' });
    }
});

router.get('/timetables/:id', async (req, res) => {
    const timetableId = req.params.id;
    try {
        const entriesQuery = `
            SELECT 
                te.id AS entry_id, te.day_of_week, te.start_time, te.end_time, te.room, te.entry_type, te.raw_entry,
                c.id AS course_id, c.course_code, c.abbreviation, c.course_title, c.category, c.sub_category, c.credits, c.ldp, c.course_type,
                (
                    SELECT json_agg(json_build_object('id', t.id, 'full_name', t.full_name, 'email', t.email, 'type', t.teacher_type))
                    FROM timetable_course_teachers tct
                    JOIN teachers t ON tct.teacher_id = t.id
                    WHERE tct.course_id = c.id AND tct.timetable_id = $1
                ) AS teachers
            FROM timetable_entries te
            LEFT JOIN courses c ON te.course_id = c.id
            WHERE te.timetable_id = $1
            ORDER BY te.start_time ASC;
        `;
        const { rows: entries } = await db.query(entriesQuery, [timetableId]);

        const studentsQuery = `
            SELECT s.id, s.registration_no, s.username, s.stream, s.email
            FROM students s JOIN student_timetable st ON s.id = st.student_id WHERE st.timetable_id = $1 ORDER BY s.registration_no ASC;
        `;
        const { rows: students } = await db.query(studentsQuery, [timetableId]);

        res.json({ entries, students, stats: { total_classes: entries.length, total_students: students.length } });
    } catch (err) {
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// POST /api/admin/timetables/:id/upload-preview
// Advanced 2D Grid + List Parser
router.post('/timetables/:id/upload-preview', upload.single('file'), async (req, res) => {
    const timetableId = req.params.id;
    if (!req.file) return res.status(400).json({ error: 'No Excel file provided' });

    try {
        const overwriteCheckAllocations = await db.query('SELECT COUNT(*) as count FROM timetable_course_teachers WHERE timetable_id = $1', [timetableId]);
        const overwriteCheckEntries = await db.query('SELECT COUNT(*) as count FROM timetable_entries WHERE timetable_id = $1', [timetableId]);
        
        const totalAllocationsDeleted = parseInt(overwriteCheckAllocations.rows[0].count) || 0;
        const totalEntriesDeleted = parseInt(overwriteCheckEntries.rows[0].count) || 0;

        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        // Read as 2D Array to handle the complex split-layout
        const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });

        let timeHeaders = [];
        let listHeaders = {};
        
        // 1. Locate Headers (Scan first 15 rows)
        for (let r = 0; r < Math.min(15, rawData.length); r++) {
            const row = rawData[r];
            for (let c = 0; c < row.length; c++) {
                const cell = row[c].toString().trim();
                if (!cell) continue;
                
                // Identify Time Slots (Grid)
                const tMatch = parseTimeHeader(cell);
                if (tMatch) {
                    timeHeaders.push({ colIndex: c, start: tMatch.start, end: tMatch.end });
                }
                
                // Identify List Headers (Right Side)
                const cUpper = cell.toUpperCase();
                if (cUpper.includes('COURSE CODE')) listHeaders['Course Code'] = c;
                if (cUpper.includes('TITLE ABBR') || cUpper === 'ABBREVIATION') listHeaders['Course Title Abbr'] = c;
                if (cUpper === 'COURSE' || cUpper === 'COURSE TITLE') listHeaders['Course'] = c;
                if (cUpper === 'COURSE FACULTY' || cUpper.includes('FACULTY NAME')) listHeaders['Course Faculty'] = c;
                if (cUpper === 'CATEGORY') listHeaders['Category'] = c;
                if (cUpper === 'CREDITS') listHeaders['Credits'] = c;
                if (cUpper === 'LDP') listHeaders['LDP'] = c;
            }
        }

        const abbrToCode = {};
        const courses = new Map();
        const allocations = [];
        const entries = []; 

        // 2. Extract List Data (Courses & Faculty)
        if (listHeaders['Course Code']) {
            for (let r = 0; r < rawData.length; r++) {
                const row = rawData[r];
                const cCode = row[listHeaders['Course Code']]?.toString().trim();
                
                if (!cCode || cCode.toUpperCase() === 'COURSE CODE') continue;

                const cTitle = row[listHeaders['Course']]?.toString().trim() || cCode;
                const abbr = row[listHeaders['Course Title Abbr']]?.toString().trim();
                const category = row[listHeaders['Category']]?.toString().trim();
                const credits = row[listHeaders['Credits']]?.toString().trim();
                const ldp = row[listHeaders['LDP']]?.toString().trim();

                if (abbr) abbrToCode[abbr] = cCode;

                if (!courses.has(cCode)) {
                    courses.set(cCode, {
                        course_code: cCode, course_title: cTitle, abbreviation: abbr, category, credits, ldp
                    });
                }

                const rawFaculty = row[listHeaders['Course Faculty']]?.toString().trim();
                if (rawFaculty) {
                    const fNames = parseTeachersList(rawFaculty);
                    fNames.forEach(fName => {
                        const cleanName = fName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                        const fEmail = `${cleanName}@bmu.edu.in`; // Enforce @bmu.edu.in
                        allocations.push({ course_code: cCode, faculty_name: fName, faculty_email: fEmail });
                    });
                }
            }
        }

        // 3. Extract Grid Data (Timetable Slots)
        if (timeHeaders.length > 0) {
            const validDays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
            for (let r = 0; r < rawData.length; r++) {
                const row = rawData[r];
                // Check first two columns for Day indicator
                const firstCell = (row[0] || '').toString().trim().toUpperCase() || (row[1] || '').toString().trim().toUpperCase();
                const matchedDay = validDays.find(d => firstCell === d || firstCell.startsWith(d));
                
                if (!matchedDay) continue;

                timeHeaders.forEach(th => {
                    const cellVal = row[th.colIndex]?.toString().trim();
                    if (!cellVal) return;

                    // Handle Lunch explicitly
                    if (cellVal.toUpperCase() === 'LUNCH' || cellVal.toUpperCase().includes('LUNCH')) {
                        entries.push({
                            day_of_week: matchedDay.substring(0,3),
                            start_time: th.start,
                            end_time: th.end,
                            course_code: null, room: null,
                            raw_entry: 'LUNCH', entry_type: 'LUNCH'
                        });
                        return;
                    }

                    // Split classes by slash or newline (e.g. AEVT GA204 / CFD GA205)
                    const classes = cellVal.split(/\n|\/|\|/);
                    classes.forEach(clsStr => {
                        const cls = clsStr.trim();
                        if (!cls) return;

                        let guessedCode = null;
                        let guessedRoom = 'TBA';

                        // Extract Room (e.g., GA204, NR209, LAB, MDC)
                        const roomMatch = cls.match(/\b([A-Z]{1,3}\d{3}[A-Z]?|LAB|MDC|MPH)\b/i);
                        if (roomMatch) guessedRoom = roomMatch[1].toUpperCase();

                        // Map via Abbreviation
                        for (const [abbr, code] of Object.entries(abbrToCode)) {
                            if (cls.toUpperCase().includes(abbr.toUpperCase())) {
                                guessedCode = code;
                                break;
                            }
                        }

                        // Fallback map via Course Code exactly
                        if (!guessedCode) {
                            const possibleCode = cls.split(' ')[0].toUpperCase();
                            if (courses.has(possibleCode)) guessedCode = possibleCode;
                        }

                        entries.push({
                            day_of_week: matchedDay.substring(0,3),
                            start_time: th.start, end_time: th.end,
                            course_code: guessedCode, room: guessedRoom, raw_entry: cls
                        });
                    });
                });
            }
        }

        res.json({
            overwrites: { total_allocations_deleted: totalAllocationsDeleted, total_entries_deleted: totalEntriesDeleted },
            preview: { courses: Array.from(courses.values()), allocations: allocations, entries: entries }
        });
    } catch (err) {
        console.error('Error parsing Excel:', err);
        res.status(500).json({ error: 'Failed to process Excel file. Ensure it matches the template.' });
    }
});

// POST /api/admin/timetables/:id/commit
router.post('/timetables/:id/commit', async (req, res) => {
    const timetableId = req.params.id;
    const { courses, allocations, entries } = req.body;

    try {
        await db.query('BEGIN');

        await db.query('DELETE FROM timetable_course_teachers WHERE timetable_id = $1', [timetableId]);
        if (entries && entries.length > 0) {
            await db.query('DELETE FROM timetable_entries WHERE timetable_id = $1', [timetableId]);
        }

        const courseIdMap = {}; 
        for (const c of courses) {
            let cRes = await db.query('SELECT id FROM courses WHERE course_code = $1', [c.course_code]);
            let creditsVal = parseFloat(c.credits) || null;
            
            if (cRes.rows.length > 0) {
                await db.query('UPDATE courses SET course_title = $1, category = $2, abbreviation = $3, credits = $4, ldp = $5 WHERE id = $6', 
                    [c.course_title, c.category, c.abbreviation, creditsVal, c.ldp, cRes.rows[0].id]);
                courseIdMap[c.course_code] = cRes.rows[0].id;
            } else {
                let newCRes = await db.query('INSERT INTO courses (course_code, course_title, category, abbreviation, credits, ldp) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', 
                    [c.course_code, c.course_title, c.category, c.abbreviation, creditsVal, c.ldp]);
                courseIdMap[c.course_code] = newCRes.rows[0].id;
            }
        }

        for (const a of allocations) {
            if(!a.faculty_email || !a.faculty_name) continue;

            // Strict Domain Enforcement Before DB Insert
            const emailPrefix = a.faculty_email.split('@')[0].trim().toLowerCase();
            const enforcedEmail = `${emailPrefix}@bmu.edu.in`;

            let tRes = await db.query('SELECT id FROM teachers WHERE email = $1', [enforcedEmail]);
            let teacherId;
            
            if (tRes.rows.length > 0) {
                await db.query('UPDATE teachers SET full_name = $1 WHERE id = $2', [a.faculty_name, tRes.rows[0].id]);
                teacherId = tRes.rows[0].id;
            } else {
                let newTRes = await db.query('INSERT INTO teachers (full_name, email, teacher_type) VALUES ($1, $2, $3) RETURNING id', 
                    [a.faculty_name, enforcedEmail, 'Faculty']);
                teacherId = newTRes.rows[0].id;
            }
            
            if (courseIdMap[a.course_code]) {
                await db.query(`
                    INSERT INTO timetable_course_teachers (teacher_id, course_id, timetable_id)
                    VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
                `, [teacherId, courseIdMap[a.course_code], timetableId]);
            }
        }

        if (entries && entries.length > 0) {
            for (const e of entries) {
                const courseId = courseIdMap[e.course_code] || null;
                const entryType = (e.raw_entry === 'LUNCH' || e.entry_type === 'LUNCH') ? 'LUNCH' : 'CLASS';
                await db.query(`
                    INSERT INTO timetable_entries (timetable_id, course_id, day_of_week, start_time, end_time, room, raw_entry, entry_type)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `, [timetableId, courseId, e.day_of_week, e.start_time, e.end_time, e.room, e.raw_entry, entryType]);
            }
        }

        await db.query('COMMIT');
        res.json({ message: 'Curriculum, Allocations, and Schedule updated successfully.' });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error('Error committing changes:', err);
        res.status(500).json({ error: 'Failed to save changes to database' });
    }
});

module.exports = router;