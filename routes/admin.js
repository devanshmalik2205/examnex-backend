const express = require('express');
const router = express.Router();
const db = require('../config/db');
const multer = require('multer');
const xlsx = require('xlsx');

// Use memory storage for processing the file immediately
const upload = multer({ storage: multer.memoryStorage() });

// GET /api/admin/stats
// Fetches real statistics for the Quick Overview dashboard
router.get('/stats', async (req, res) => {
    try {
        const examsResult = await db.query('SELECT COUNT(DISTINCT course_id) as total FROM timetable_entries');
        const studentsResult = await db.query('SELECT COUNT(*) as total FROM students');
        const roomsResult = await db.query('SELECT COUNT(DISTINCT room) as total FROM timetable_entries WHERE room IS NOT NULL');
        
        // Simple clash detection: same room, same day, overlapping times
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
// Fetches the list of all available timetables (Batches, Streams, Semesters)
router.get('/timetables', async (req, res) => {
    try {
        const query = `
            SELECT id, batch_year, stream, semester, source_sheet 
            FROM timetables 
            ORDER BY batch_year DESC, stream ASC;
        `;
        const { rows } = await db.query(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching timetables:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// GET /api/admin/timetables/:id
// Fetches entries, course details, associated teachers, and enrolled students
router.get('/timetables/:id', async (req, res) => {
    const timetableId = req.params.id;

    try {
        // 1. Fetch entries with course info and mapped teachers
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

        // 2. Fetch students assigned to this timetable
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
// Handles Excel file upload, parses it, and returns a preview of changes
router.post('/timetables/:id/upload-preview', upload.single('file'), async (req, res) => {
    const timetableId = req.params.id;
    
    if (!req.file) return res.status(400).json({ error: 'No Excel file provided' });

    try {
        // Calculate potential overwrites (existing entries for this timetable)
        const overwriteCheck = await db.query('SELECT COUNT(*) as count FROM timetable_entries WHERE timetable_id = $1', [timetableId]);
        const totalDeleted = parseInt(overwriteCheck.rows[0].count) || 0;

        // Parse Excel from memory buffer
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        const courses = new Map();
        const teachers = new Map();
        const entries = [];

        rawData.forEach(row => {
            // Check for valid rows. Adjust these property names if your excel columns differ 
            // e.g. row['Course Code'] instead of row.CourseCode
            const cCode = (row.CourseCode || row.Course_Code || row.SubjectCode || '')?.toString().trim();
            const day = (row.Day || row.Day_of_Week || row.Weekday || '')?.toString().trim();
            
            if (!cCode || !day) return; 

            if (!courses.has(cCode)) {
                courses.set(cCode, {
                    course_code: cCode,
                    course_title: row.CourseTitle || row.Subject || cCode,
                    category: row.Category || 'Core'
                });
            }

            const fName = row.FacultyName || row.Teacher || row.Faculty;
            if (fName) {
                const fEmail = row.FacultyEmail || row.Email || `${fName.replace(/\s+/g, '').toLowerCase()}@university.edu`;
                if (!teachers.has(fEmail)) {
                    teachers.set(fEmail, {
                        full_name: fName,
                        email: fEmail,
                        linked_course_code: cCode
                    });
                }
            }

            entries.push({
                day_of_week: day.substring(0, 3).toUpperCase(), // E.g., MON, TUE
                start_time: row.StartTime || '09:00:00',
                end_time: row.EndTime || '09:55:00',
                course_code: cCode,
                room: row.Room || row.Classroom || 'TBA',
                raw_entry: row.CourseTitle || cCode
            });
        });

        res.json({
            overwrites: {
                total_entries_deleted: totalDeleted
            },
            preview: {
                courses: Array.from(courses.values()),
                teachers: Array.from(teachers.values()),
                entries: entries
            }
        });
    } catch (err) {
        console.error('Error parsing Excel:', err);
        res.status(500).json({ error: 'Failed to process Excel file. Ensure it is a valid .xlsx or .csv format.' });
    }
});

// POST /api/admin/timetables/:id/commit
// Commits the parsed Excel preview data to the database safely
router.post('/timetables/:id/commit', async (req, res) => {
    const timetableId = req.params.id;
    const { courses, teachers, entries } = req.body;

    try {
        await db.query('BEGIN');

        // 1. Wipe existing entries and allocations for this timetable to prevent overlaps
        await db.query('DELETE FROM timetable_entries WHERE timetable_id = $1', [timetableId]);
        await db.query('DELETE FROM timetable_course_teachers WHERE timetable_id = $1', [timetableId]);

        // 2. Insert or fetch existing Courses
        const courseIdMap = {}; // Maps course_code to DB id
        for (const c of courses) {
            let cRes = await db.query('SELECT id FROM courses WHERE course_code = $1', [c.course_code]);
            if (cRes.rows.length > 0) {
                await db.query('UPDATE courses SET course_title = $1, category = $2 WHERE id = $3', [c.course_title, c.category, cRes.rows[0].id]);
                courseIdMap[c.course_code] = cRes.rows[0].id;
            } else {
                let newCRes = await db.query('INSERT INTO courses (course_code, course_title, category) VALUES ($1, $2, $3) RETURNING id', [c.course_code, c.course_title, c.category]);
                courseIdMap[c.course_code] = newCRes.rows[0].id;
            }
        }

        // 3. Insert or fetch existing Teachers & Link them
        for (const t of teachers) {
            let tRes = await db.query('SELECT id FROM teachers WHERE email = $1', [t.email]);
            let teacherId;
            if (tRes.rows.length > 0) {
                await db.query('UPDATE teachers SET full_name = $1 WHERE id = $2', [t.full_name, tRes.rows[0].id]);
                teacherId = tRes.rows[0].id;
            } else {
                let newTRes = await db.query('INSERT INTO teachers (full_name, email, teacher_type) VALUES ($1, $2, $3) RETURNING id', [t.full_name, t.email, 'Faculty']);
                teacherId = newTRes.rows[0].id;
            }
            
            // Map teacher to course for this timetable
            if (t.linked_course_code && courseIdMap[t.linked_course_code]) {
                await db.query(`
                    INSERT INTO timetable_course_teachers (teacher_id, course_id, timetable_id)
                    VALUES ($1, $2, $3)
                    ON CONFLICT DO NOTHING
                `, [teacherId, courseIdMap[t.linked_course_code], timetableId]);
            }
        }

        // 4. Insert Entries
        for (const e of entries) {
            const courseId = courseIdMap[e.course_code] || null;
            await db.query(`
                INSERT INTO timetable_entries (timetable_id, course_id, day_of_week, start_time, end_time, room, raw_entry)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [timetableId, courseId, e.day_of_week, e.start_time, e.end_time, e.room, e.raw_entry]);
        }

        await db.query('COMMIT');
        res.json({ message: 'Timetable updated successfully from Excel.' });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error('Error committing timetable:', err);
        res.status(500).json({ error: 'Failed to save changes to database' });
    }
});

module.exports = router;