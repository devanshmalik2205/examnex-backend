const express = require('express');
const router = express.Router();
const db = require('../config/db');
const bcrypt = require('bcryptjs');

// GET all students
router.get('/', async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT id, registration_no, stream, username, email FROM students ORDER BY registration_no ASC'
        );
        res.json(rows);
    } catch (err) {
        console.error('Error fetching students:', err);
        res.status(500).json({ error: 'Server error fetching students' });
    }
});

// POST a new student
router.post('/', async (req, res) => {
    const { registration_no, stream, username, email, password } = req.body;
    
    try {
        // Basic validation
        if (!registration_no || !username || !password) {
            return res.status(400).json({ error: 'Registration No, Username, and Password are required' });
        }

        // Hash the password
        const salt = await bcrypt.genSalt(6); // Using 6 rounds to match dump format $2a$06$
        const hashedPassword = await bcrypt.hash(password, salt);

        const { rows } = await db.query(
            `INSERT INTO students (registration_no, stream, username, email, password) 
             VALUES ($1, $2, $3, $4, $5) 
             RETURNING id, registration_no, stream, username, email`,
            [registration_no, stream, username, email, hashedPassword]
        );
        
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Error adding student:', err);
        // Handle unique constraint violations
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Registration Number or Username already exists' });
        }
        res.status(500).json({ error: 'Server error adding student' });
    }
});

// PUT (Edit) a student
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { registration_no, stream, username, email, password } = req.body;

    try {
        let query, values;

        // If password is provided, update it. Otherwise, keep the old one.
        if (password && password.trim() !== '') {
            const salt = await bcrypt.genSalt(6);
            const hashedPassword = await bcrypt.hash(password, salt);
            
            query = `
                UPDATE students 
                SET registration_no = $1, stream = $2, username = $3, email = $4, password = $5 
                WHERE id = $6 
                RETURNING id, registration_no, stream, username, email
            `;
            values = [registration_no, stream, username, email, hashedPassword, id];
        } else {
            query = `
                UPDATE students 
                SET registration_no = $1, stream = $2, username = $3, email = $4 
                WHERE id = $5 
                RETURNING id, registration_no, stream, username, email
            `;
            values = [registration_no, stream, username, email, id];
        }

        const { rows } = await db.query(query, values);
        
        if (rows.length === 0) return res.status(404).json({ error: 'Student not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Error updating student:', err);
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Registration Number or Username already exists' });
        }
        res.status(500).json({ error: 'Server error updating student' });
    }
});

// DELETE a student
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Use a transaction to safely remove foreign key dependencies first
        await db.query('BEGIN');
        
        // Remove timetable mapping for the student
        await db.query('DELETE FROM student_timetable WHERE student_id = $1', [id]);
        
        // Delete the student record
        await db.query('DELETE FROM students WHERE id = $1', [id]);
        
        await db.query('COMMIT');
        res.json({ message: 'Student deleted successfully' });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error('Error deleting student:', err);
        res.status(500).json({ error: 'Server error deleting student' });
    }
});

module.exports = router;