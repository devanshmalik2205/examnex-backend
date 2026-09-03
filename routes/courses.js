const express = require('express');
const router = express.Router();
const db = require('../config/db');

// GET all courses grouped logically
router.get('/', async (req, res) => {
    try {
        // Fetch all courses
        const coursesQuery = `
            SELECT 
                id, 
                course_code, 
                course_title, 
                category, 
                credits,
                course_type
            FROM courses
            ORDER BY course_title ASC
        `;
        const { rows: courses } = await db.query(coursesQuery);

        // Fetch mapping to timetables to determine year/semester grouping
        const mappingQuery = `
            SELECT DISTINCT
                tct.course_id,
                t.batch_year,
                t.semester
            FROM timetable_course_teachers tct
            JOIN timetables t ON tct.timetable_id = t.id
        `;
        const { rows: mappings } = await db.query(mappingQuery);

        // Map course IDs to their respective years/semesters for easier grouping on the frontend
        const courseMapping = {};
        mappings.forEach(m => {
            if (!courseMapping[m.course_id]) courseMapping[m.course_id] = [];
            courseMapping[m.course_id].push({ year: m.batch_year, semester: m.semester });
        });

        const enrichedCourses = courses.map(c => ({
            ...c,
            taught_in: courseMapping[c.id] || []
        }));

        res.json(enrichedCourses);
    } catch (err) {
        console.error('Error fetching courses:', err);
        res.status(500).json({ error: 'Server error fetching courses' });
    }
});

// GET specific course details including teachers and classes
router.get('/:id/details', async (req, res) => {
    const courseId = req.params.id;

    try {
        // Fetch basic course details
        const courseRes = await db.query('SELECT * FROM courses WHERE id = $1', [courseId]);
        if (courseRes.rows.length === 0) return res.status(404).json({ error: 'Course not found' });
        
        const course = courseRes.rows[0];

        // Fetch teachers assigned to this course and the specific class (timetable) they teach
        const teachersQuery = `
            SELECT 
                t.id AS teacher_id,
                t.full_name AS teacher_name,
                t.email,
                t.teacher_type,
                tb.batch_year,
                tb.stream,
                tb.semester
            FROM timetable_course_teachers tct
            JOIN teachers t ON tct.teacher_id = t.id
            JOIN timetables tb ON tct.timetable_id = tb.id
            WHERE tct.course_id = $1
            ORDER BY t.full_name ASC
        `;
        const { rows: teachersRaw } = await db.query(teachersQuery, [courseId]);

        // Group the results so a teacher isn't duplicated if they teach multiple classes of the same course
        const teacherMap = new Map();
        teachersRaw.forEach(row => {
            if (!teacherMap.has(row.teacher_id)) {
                teacherMap.set(row.teacher_id, {
                    id: row.teacher_id,
                    name: row.teacher_name,
                    email: row.email,
                    type: row.teacher_type,
                    classes: []
                });
            }
            teacherMap.get(row.teacher_id).classes.push(`${row.stream} - Sem ${row.semester} (${row.batch_year})`);
        });

        res.json({
            course: course,
            teachers: Array.from(teacherMap.values())
        });
    } catch (err) {
        console.error('Error fetching course details:', err);
        res.status(500).json({ error: 'Server error fetching course details' });
    }
});

module.exports = router;