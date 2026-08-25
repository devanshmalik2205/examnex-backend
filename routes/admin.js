const express = require('express');
const router = express.Router();
const db = require('../config/db');

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
                c.id AS course_id, c.course_code, c.course_title, c.course_type, c.credits,
                (
                    SELECT json_agg(json_build_object(
                        'id', t.id, 
                        'full_name', t.full_name, 
                        'email', t.email,
                        'type', t.teacher_type
                    ))
                    FROM course_teachers ct
                    JOIN teachers t ON ct.teacher_id = t.id
                    WHERE ct.course_id = c.id
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

module.exports = router;