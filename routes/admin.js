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
    // Strip connective prefixes like "With " or "And " occasionally found at the start
    cleaned = cleaned.replace(/^(With\s+|And\s+)/i, '');
    
    // Strip titles case-insensitively
    const prefixRegex = /^(Dr\.|Dr\s|Mr\.|Mr\s|Mrs\.|Mrs\s|Ms\.|Ms\s|Prof\.|Prof\s|Er\.|Er\s)+/i;
    while (prefixRegex.test(cleaned)) {
        cleaned = cleaned.replace(prefixRegex, '').trim();
    }
    return cleaned;
};

// Helper to split multiple teachers in a single cell
const parseTeachersList = (rawString) => {
    if (!rawString) return [];
    // Split by " and ", "&", "/", ","
    const parts = rawString.split(/\s+and\s+|\s*&\s*|\s*\/\s*|,/i);
    return parts.map(p => cleanTeacherName(p)).filter(p => p.length > 0);
};

// GET /api/admin/stats
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
        console.error('Error fetching stats:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// GET /api/admin/timetables
router.get('/timetables', async (req, res) => {
    try {
        const query = `
            SELECT id, batch_year, stream, semester, source_sheet 
            FROM timetables 
            ORDER BY batch_year DESC, stream ASC, semester ASC;
        `;
        const { rows } = await db.query(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching timetables:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// POST /api/admin/timetables (Create a new Section/Class)
router.post('/timetables', async (req, res) => {
    const { batch_year, stream, semester } = req.body;
    try {
        const { rows } = await db.query(
            'INSERT INTO timetables (batch_year, stream, semester) VALUES ($1, $2, $3) RETURNING *',
            [batch_year, stream, semester]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Error creating section:', err);
        if (err.code === '23505') {
            return res.status(400).json({ error: 'This specific Batch, Stream, and Semester combination already exists.' });
        }
        res.status(500).json({ error: 'Failed to create section.' });
    }
});

// DELETE /api/admin/timetables/:id (Delete a Section/Class)
router.delete('/timetables/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('BEGIN');
        // Delete dependent relationships first
        await db.query('DELETE FROM timetable_entries WHERE timetable_id = $1', [id]);
        await db.query('DELETE FROM timetable_course_teachers WHERE timetable_id = $1', [id]);
        await db.query('DELETE FROM student_timetable WHERE timetable_id = $1', [id]);
        
        // Delete the timetable itself
        await db.query('DELETE FROM timetables WHERE id = $1', [id]);
        await db.query('COMMIT');
        res.json({ message: 'Section deleted successfully.' });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error('Error deleting section:', err);
        res.status(500).json({ error: 'Failed to delete section.' });
    }
});

// GET /api/admin/timetables/:id
router.get('/timetables/:id', async (req, res) => {
    const timetableId = req.params.id;

    try {
        const entriesQuery = `
            SELECT 
                te.id AS entry_id, te.day_of_week, te.start_time, te.end_time, te.room, te.entry_type, te.raw_entry,
                c.id AS course_id, c.course_code, c.abbreviation, c.course_title, c.category, c.sub_category, c.credits, c.ldp, c.course_type,
                (
                    SELECT json_agg(json_build_object(
                        'id', t.id, 
                        'full_name', t.full_name, 
                        'email', t.email,
                        'type', t.teacher_type
                    ))
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
            FROM students s
            JOIN student_timetable st ON s.id = st.student_id
            WHERE st.timetable_id = $1
            ORDER BY s.registration_no ASC;
        `;
        const { rows: students } = await db.query(studentsQuery, [timetableId]);

        res.json({
            entries: entries,
            students: students,
            stats: {
                total_classes: entries.length,
                total_students: students.length
            }
        });
    } catch (err) {
        console.error('Error fetching timetable details:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// POST /api/admin/timetables/:id/upload-preview
// Handles Curriculum, Faculty Allocations, and Schedule extraction
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
        const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        const courses = new Map();
        const allocations = [];
        const entries = []; 

        rawData.forEach(row => {
            const cCode = (row['Course Code'] || row.CourseCode || row.SubjectCode || '').toString().trim();
            const cTitle = (row['Course'] || row.CourseTitle || row.Subject || '').toString().trim();
            
            // If the row is missing fundamental course info, skip
            if (!cCode) return; 

            // Extract Course Details
            const abbreviation = (row['Course Title Abbreviation'] || row.Abbreviation || '').toString().trim();
            const category = (row['Category'] || '').toString().trim();
            let credits = (row['Credits'] || '').toString().trim();
            const ldp = (row['LDP'] || '').toString().trim();

            if (!courses.has(cCode)) {
                courses.set(cCode, {
                    course_code: cCode,
                    course_title: cTitle || cCode,
                    abbreviation,
                    category,
                    credits,
                    ldp
                });
            }

            // Extract Faculty mapping (Clean and Split logic)
            const rawFaculty = (row['Course Faculty'] || row['Faculty Name'] || row.Teacher || row.Faculty || '').toString().trim();
            const facultyNames = parseTeachersList(rawFaculty);
            
            facultyNames.forEach(fName => {
                const fEmail = `${fName.replace(/\s+/g, '').toLowerCase()}@university.edu`;
                allocations.push({
                    course_code: cCode,
                    faculty_name: fName,
                    faculty_email: fEmail
                });
            });

            // Extract Standard Timetable Layout (Day, Time, Room) if present
            const day = (row.Day || row.Day_of_Week || row.Weekday || '').toString().trim();
            const start = (row.StartTime || row['Start Time'] || row.Start || '').toString().trim();
            const end = (row.EndTime || row['End Time'] || row.End || '').toString().trim();
            const room = (row.Room || row.Classroom || row['Room No'] || row['Room No.'] || 'TBA').toString().trim();

            if (day && start && end) {
                entries.push({
                    day_of_week: day.substring(0, 3).toUpperCase(),
                    start_time: start,
                    end_time: end,
                    course_code: cCode,
                    room: room,
                    raw_entry: cTitle || cCode
                });
            }
        });

        res.json({
            overwrites: {
                total_allocations_deleted: totalAllocationsDeleted,
                total_entries_deleted: totalEntriesDeleted
            },
            preview: {
                courses: Array.from(courses.values()),
                allocations: allocations,
                entries: entries
            }
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

        // 1. Wipe existing allocations and entries for this timetable
        await db.query('DELETE FROM timetable_course_teachers WHERE timetable_id = $1', [timetableId]);
        
        // Only wipe entries if new entries are being uploaded in this excel file
        if (entries && entries.length > 0) {
            await db.query('DELETE FROM timetable_entries WHERE timetable_id = $1', [timetableId]);
        }

        // 2. Insert or fetch existing Courses
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

        // 3. Insert or fetch existing Teachers & Link them
        for (const a of allocations) {
            if(!a.faculty_email || !a.faculty_name) continue;

            let tRes = await db.query('SELECT id FROM teachers WHERE email = $1', [a.faculty_email]);
            let teacherId;
            
            if (tRes.rows.length > 0) {
                await db.query('UPDATE teachers SET full_name = $1 WHERE id = $2', [a.faculty_name, tRes.rows[0].id]);
                teacherId = tRes.rows[0].id;
            } else {
                let newTRes = await db.query('INSERT INTO teachers (full_name, email, teacher_type) VALUES ($1, $2, $3) RETURNING id', 
                    [a.faculty_name, a.faculty_email, 'Faculty']);
                teacherId = newTRes.rows[0].id;
            }
            
            if (courseIdMap[a.course_code]) {
                await db.query(`
                    INSERT INTO timetable_course_teachers (teacher_id, course_id, timetable_id)
                    VALUES ($1, $2, $3)
                    ON CONFLICT DO NOTHING
                `, [teacherId, courseIdMap[a.course_code], timetableId]);
            }
        }

        // 4. Update Time slots ONLY IF included 
        if (entries && entries.length > 0) {
            for (const e of entries) {
                const courseId = courseIdMap[e.course_code] || null;
                await db.query(`
                    INSERT INTO timetable_entries (timetable_id, course_id, day_of_week, start_time, end_time, room, raw_entry)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [timetableId, courseId, e.day_of_week, e.start_time, e.end_time, e.room, e.raw_entry]);
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