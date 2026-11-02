const express = require('express');
const router = express.Router();
const db = require('../config/db');

// GET all required data for the invigilation assignment algorithm
router.get('/data', async (req, res) => {
    try {
        // Fetch all exam schedule entries with their rooms and courses
        // We join with timetables to get batch information
        const examsQuery = `
            SELECT 
                te.id, 
                te.day_of_week as date, 
                te.start_time, 
                te.end_time, 
                te.room,
                c.course_code, 
                c.course_title, 
                t.batch_year, 
                t.stream, 
                t.semester
            FROM timetable_entries te
            LEFT JOIN courses c ON te.course_id = c.id
            LEFT JOIN timetables t ON te.timetable_id = t.id
            WHERE te.entry_type = 'EXAM'
            ORDER BY te.day_of_week, te.start_time, te.room
        `;
        const { rows: exams } = await db.query(examsQuery);

        // Fetch all teachers, their designations, and all courses they teach
        const teachersQuery = `
            SELECT 
                t.id, 
                t.full_name, 
                t.teacher_type, 
                t.department,
                COALESCE(
                    json_agg(DISTINCT c.course_code) FILTER (WHERE c.course_code IS NOT NULL), 
                    '[]'
                ) as courses_taught
            FROM teachers t
            LEFT JOIN timetable_course_teachers tct ON t.id = tct.teacher_id
            LEFT JOIN courses c ON tct.course_id = c.id
            GROUP BY t.id
            ORDER BY t.full_name ASC
        `;
        const { rows: teachers } = await db.query(teachersQuery);

        res.json({
            exams: exams,
            teachers: teachers
        });
    } catch (err) {
        console.error('Error fetching invigilation assignment data:', err);
        res.status(500).json({ error: 'Server error fetching invigilation assignment data' });
    }
});

module.exports = router;