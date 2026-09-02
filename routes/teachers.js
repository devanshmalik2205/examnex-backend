const express = require('express');
const router = express.Router();
const db = require('../config/db');

// GET all teachers
router.get('/', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT id, full_name, email, teacher_type FROM teachers ORDER BY full_name ASC');
        res.json(rows);
    } catch (err) {
        console.error('Error fetching teachers:', err);
        res.status(500).json({ error: 'Server error fetching teachers' });
    }
});

// POST a new teacher
router.post('/', async (req, res) => {
    const { full_name, email, teacher_type } = req.body;
    try {
        const { rows } = await db.query(
            'INSERT INTO teachers (full_name, email, teacher_type) VALUES ($1, $2, $3) RETURNING *',
            [full_name, email, teacher_type || 'Faculty']
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Error adding teacher:', err);
        res.status(500).json({ error: 'Server error adding teacher' });
    }
});

// PUT (Edit) a teacher
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { full_name, email, teacher_type } = req.body;
    try {
        const { rows } = await db.query(
            'UPDATE teachers SET full_name = $1, email = $2, teacher_type = $3 WHERE id = $4 RETURNING *',
            [full_name, email, teacher_type, id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Teacher not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Error updating teacher:', err);
        res.status(500).json({ error: 'Server error updating teacher' });
    }
});

// DELETE a teacher
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM teachers WHERE id = $1', [id]);
        res.json({ message: 'Teacher deleted successfully' });
    } catch (err) {
        console.error('Error deleting teacher:', err);
        res.status(500).json({ error: 'Server error deleting teacher' });
    }
});

// GET allocations for a specific teacher
router.get('/:id/allocations', async (req, res) => {
    const { id } = req.params;
    try {
        // Fetch all courses and timetables (sections) the teacher is allocated to
        const { rows } = await db.query(`
            SELECT tct.course_id, tct.timetable_id, c.course_name, c.course_code, t.name as timetable_name
            FROM timetable_course_teachers tct
            JOIN courses c ON tct.course_id = c.id
            JOIN timetables t ON tct.timetable_id = t.id
            WHERE tct.teacher_id = $1
        `, [id]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching allocations:', err);
        res.status(500).json({ error: 'Server error fetching allocations' });
    }
});

// POST (Update) allocations for a teacher
router.post('/:id/allocations', async (req, res) => {
    const { id } = req.params;
    const { allocations } = req.body; // Array of { course_id, timetable_id }

    try {
        await db.query('BEGIN');
        
        // 1. Remove existing allocations for this teacher
        await db.query('DELETE FROM timetable_course_teachers WHERE teacher_id = $1', [id]);

        // 2. Insert new allocations
        if (allocations && allocations.length > 0) {
            for (let alloc of allocations) {
                await db.query(
                    'INSERT INTO timetable_course_teachers (teacher_id, course_id, timetable_id) VALUES ($1, $2, $3)',
                    [id, alloc.course_id, alloc.timetable_id]
                );
            }
        }

        await db.query('COMMIT');
        res.json({ message: 'Allocations updated successfully' });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error('Error updating allocations:', err);
        res.status(500).json({ error: 'Server error updating allocations' });
    }
});

// GET dropdown data for allocations (Courses and Sections/Timetables)
router.get('/data/options', async (req, res) => {
    try {
        const courses = await db.query('SELECT id, course_name, course_code FROM courses ORDER BY course_name ASC');
        const timetables = await db.query('SELECT id, name FROM timetables ORDER BY name ASC'); // Assuming timetables act as sections
        
        res.json({
            courses: courses.rows,
            sections: timetables.rows
        });
    } catch (err) {
        console.error('Error fetching options:', err);
        res.status(500).json({ error: 'Server error fetching allocation options' });
    }
});

module.exports = router;