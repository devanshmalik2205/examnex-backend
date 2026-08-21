const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs'); // We use bcryptjs for pure JS implementation, easier for deployments
const pool = require('../config/db');

// @route   POST /api/auth/login
// @desc    Authenticate user (Student or Faculty) and return user data
// @access  Public
router.post('/login', async (req, res) => {
    const { username, password, role } = req.body;

    // Validate request
    if (!username || !password || !role) {
        return res.status(400).json({ message: 'Please provide username, password, and role.' });
    }

    try {
        if (role === 'student') {
            // For students, the frontend sends the Registration No. as 'username'
            const result = await pool.query(
                'SELECT id, registration_no, stream, username as name, password, email FROM students WHERE registration_no = $1 OR email = $1',
                [username]
            );

            if (result.rows.length === 0) {
                return res.status(401).json({ message: 'Student not found or invalid credentials.' });
            }

            const user = result.rows[0];
            const isMatch = await bcrypt.compare(password, user.password);

            if (!isMatch) {
                return res.status(401).json({ message: 'Invalid credentials.' });
            }

            // Remove password from response
            delete user.password;
            
            return res.status(200).json({
                message: 'Login successful',
                user: {
                    id: user.id,
                    username: user.registration_no,
                    name: user.name,
                    stream: user.stream,
                    email: user.email,
                    role: 'student'
                }
            });

        } else if (role === 'faculty') {
            const result = await pool.query(
                'SELECT id, username, full_name, contact, email, teacher_type, school, password FROM teachers WHERE username = $1 OR email = $1',
                [username]
            );

            if (result.rows.length === 0) {
                return res.status(401).json({ message: 'Faculty not found or invalid credentials.' });
            }

            const user = result.rows[0];
            const isMatch = await bcrypt.compare(password, user.password);

            if (!isMatch) {
                return res.status(401).json({ message: 'Invalid credentials.' });
            }

            // Remove password from response
            delete user.password;

            return res.status(200).json({
                message: 'Login successful',
                user: {
                    id: user.id,
                    username: user.username,
                    name: user.full_name,
                    type: user.teacher_type,
                    email: user.email,
                    role: 'faculty'
                }
            });
        } else {
            return res.status(400).json({ message: 'Invalid role specified for API login.' });
        }

    } catch (err) {
        console.error("Login Error: ", err);
        return res.status(500).json({ message: 'Server error during login process.' });
    }
});

module.exports = router;