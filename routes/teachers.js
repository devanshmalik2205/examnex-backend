const express = require('express');
const router = express.Router();
const db = require('../config/db');
const multer = require('multer');
const xlsx = require('xlsx');

const upload = multer({ storage: multer.memoryStorage() });

// Helper to strictly enforce dotted format and domain
const enforceBMUEmail = (email, name) => {
    if (!email) {
        if (!name) return '';
        // Create dotted email: kiran.sharma@bmu.edu.in
        const cleaned = name.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '.').toLowerCase();
        return `${cleaned}@bmu.edu.in`;
    }
    // If they typed something like user.name@gmail.com, force it to @bmu.edu.in
    const emailPrefix = email.split('@')[0].trim().toLowerCase();
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
    let { full_name, email, teacher_type } = req.body;
    email = enforceBMUEmail(email, full_name);

    try {
        const { rows } = await db.query(
            'INSERT INTO teachers (full_name, email, teacher_type) VALUES ($1, $2, $3) RETURNING *',
            [full_name, email, teacher_type || 'Faculty']
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error adding teacher' });
    }
});

router.put('/:id', async (req, res) => {
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
        const existingRes = await db.query('SELECT email FROM teachers');
        const existingEmails = new Set(existingRes.rows.map(r => r.email));

        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        const parsedTeachers = new Map();
        let totalUpdates = 0;

        rawData.forEach(row => {
            const fName = (row.FacultyName || row.Name || row.Teacher || row.Faculty || '')?.toString().trim();
            const fType = (row.Type || row.TeacherType || 'Faculty')?.toString().trim();
            if (!fName) return; 

            let fEmail = enforceBMUEmail((row.FacultyEmail || row.Email || '')?.toString().trim(), fName);

            const isUpdate = existingEmails.has(fEmail);
            if (isUpdate && !parsedTeachers.has(fEmail)) {
                totalUpdates++;
            }

            parsedTeachers.set(fEmail, { full_name: fName, email: fEmail, teacher_type: fType, is_update: isUpdate });
        });

        res.json({ overwrites: { total_updates: totalUpdates }, preview: { teachers: Array.from(parsedTeachers.values()) } });
    } catch (err) {
        res.status(500).json({ error: 'Failed to process Excel file. Ensure it is a valid format.' });
    }
});

router.post('/commit-upload', async (req, res) => {
    const { teachers } = req.body;
    if (!teachers || !Array.isArray(teachers)) return res.status(400).json({ error: 'Invalid teacher data provided' });

    try {
        await db.query('BEGIN');

        for (const t of teachers) {
            if (!t.full_name) continue;
            const enforcedEmail = enforceBMUEmail(t.email, t.full_name);

            const checkRes = await db.query('SELECT id FROM teachers WHERE email = $1', [enforcedEmail]);
            if (checkRes.rows.length > 0) {
                await db.query('UPDATE teachers SET full_name = $1, teacher_type = $2 WHERE email = $3', [t.full_name, t.teacher_type, enforcedEmail]);
            } else {
                await db.query('INSERT INTO teachers (full_name, email, teacher_type) VALUES ($1, $2, $3)', [t.full_name, enforcedEmail, t.teacher_type || 'Faculty']);
            }
        }

        await db.query('COMMIT');
        res.json({ message: 'Teachers imported successfully from Excel.' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to save changes to database' });
    }
});

module.exports = router;