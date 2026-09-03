const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const teacherRoutes = require('./routes/teachers');
const studentRoutes = require('./routes/students'); // <-- Added students route

const app = express();

// Middleware
app.use(cors({
    origin: true, // Allow any origin to connect (solves Cloudflare to Render blocks)
    credentials: true,
}));
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/teachers', teacherRoutes);
app.use('/api/admin/students', studentRoutes); // <-- Mounted students route

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', message: 'Backend is running smoothly' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});