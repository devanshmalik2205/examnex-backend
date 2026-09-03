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
                abbreviation,
                course_title, 
                category, 
                credits,
                ldp,
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

// POST a new course
router.post('/', async (req, res) => {
    const { course_code, abbreviation, course_title, category, credits, ldp, course_type } = req.body;
    
    try {
        if (!course_title) {
            return res.status(400).json({ error: 'Course Title is required' });
        }

        const { rows } = await db.query(
            `INSERT INTO courses (course_code, abbreviation, course_title, category, credits, ldp, course_type) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) 
             RETURNING *`,
            [course_code || null, abbreviation || null, course_title, category || null, credits ? parseFloat(credits) : null, ldp || null, course_type || 'regular']
        );
        
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Error adding course:', err);
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Course with this Code and Abbreviation already exists' });
        }
        res.status(500).json({ error: 'Server error adding course' });
    }
});

// PUT (Edit) a course
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { course_code, abbreviation, course_title, category, credits, ldp, course_type } = req.body;

    try {
        const { rows } = await db.query(
            `UPDATE courses 
             SET course_code = $1, abbreviation = $2, course_title = $3, category = $4, credits = $5, ldp = $6, course_type = $7 
             WHERE id = $8 
             RETURNING *`,
            [course_code || null, abbreviation || null, course_title, category || null, credits ? parseFloat(credits) : null, ldp || null, course_type || 'regular', id]
        );
        
        if (rows.length === 0) return res.status(404).json({ error: 'Course not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Error updating course:', err);
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Course with this Code and Abbreviation already exists' });
        }
        res.status(500).json({ error: 'Server error updating course' });
    }
});

// DELETE a course
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Due to CASCADE and SET NULL foreign keys set in the database, 
        // deleting the course will automatically clean up mapping tables safely.
        await db.query('DELETE FROM courses WHERE id = $1', [id]);
        res.json({ message: 'Course deleted successfully' });
    } catch (err) {
        console.error('Error deleting course:', err);
        res.status(500).json({ error: 'Server error deleting course' });
    }
});

module.exports = router;