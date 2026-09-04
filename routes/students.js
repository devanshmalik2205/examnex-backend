const express = require('express');
const router = express.Router();
const db = require('../config/db');
const bcrypt = require('bcryptjs');

// Helper to auto-link student to timetables based on RegNo (Year) and Stream
const linkStudentToTimetable = async (studentId, registration_no, stream) => {
    try {
        await db.query('DELETE FROM student_timetable WHERE student_id = $1', [studentId]);
        if (!registration_no || !stream) return;

        // "240C2070001" -> "24" -> "2024"
        const yearPrefix = registration_no.substring(0, 2);
        if (!yearPrefix || isNaN(yearPrefix)) return;
        
        const batchYear = parseInt(`20${yearPrefix}`, 10);
        const cleanStream = stream.trim(); 

        // Link them to ALL timetables assigned to their specific Batch & Stream 
        const ttRes = await db.query(
            'SELECT id FROM timetables WHERE batch_year = $1 AND UPPER(TRIM(stream)) = UPPER($2)',
            [batchYear, cleanStream]
        );

        for (const tt of ttRes.rows) {
            await db.query(
                'INSERT INTO student_timetable (student_id, timetable_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [studentId, tt.id]
            );
        }
    } catch (err) {
        console.error("Error linking student:", err);
    }
};

router.get('/', async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT id, registration_no, stream, username, email FROM students ORDER BY registration_no ASC'
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching students' });
    }
});

router.post('/', async (req, res) => {
    const { registration_no, stream, username, email, password } = req.body;
    
    try {
        if (!registration_no || !username) {
            return res.status(400).json({ error: 'Registration No and Username are required' });
        }

        const rawPassword = password || 'password123';
        const salt = await bcrypt.genSalt(6); 
        const hashedPassword = await bcrypt.hash(rawPassword, salt);

        const { rows } = await db.query(
            `INSERT INTO students (registration_no, stream, username, email, password) 
             VALUES ($1, $2, $3, $4, $5) 
             RETURNING id, registration_no, stream, username, email`,
            [registration_no, stream, username, email, hashedPassword]
        );
        
        const newStudent = rows[0];
        await linkStudentToTimetable(newStudent.id, newStudent.registration_no, newStudent.stream);

        res.status(201).json(newStudent);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Registration Number already exists' });
        }
        res.status(500).json({ error: 'Server error adding student' });
    }
});

router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { registration_no, stream, username, email, password } = req.body;

    try {
        let query, values;

        if (password && password.trim() !== '') {
            const salt = await bcrypt.genSalt(6);
            const hashedPassword = await bcrypt.hash(password, salt);
            query = `UPDATE students SET registration_no = $1, stream = $2, username = $3, email = $4, password = $5 WHERE id = $6 RETURNING id, registration_no, stream, username, email`;
            values = [registration_no, stream, username, email, hashedPassword, id];
        } else {
            query = `UPDATE students SET registration_no = $1, stream = $2, username = $3, email = $4 WHERE id = $5 RETURNING id, registration_no, stream, username, email`;
            values = [registration_no, stream, username, email, id];
        }

        const { rows } = await db.query(query, values);
        if (rows.length === 0) return res.status(404).json({ error: 'Student not found' });
        
        const updatedStudent = rows[0];
        await linkStudentToTimetable(updatedStudent.id, updatedStudent.registration_no, updatedStudent.stream);

        res.json(updatedStudent);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Registration Number already exists' });
        }
        res.status(500).json({ error: 'Server error updating student' });
    }
});

router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('BEGIN');
        await db.query('DELETE FROM student_timetable WHERE student_id = $1', [id]);
        await db.query('DELETE FROM students WHERE id = $1', [id]);
        await db.query('COMMIT');
        res.json({ message: 'Student deleted successfully' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: 'Server error deleting student' });
    }
});

module.exports = router;