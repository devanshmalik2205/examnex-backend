const express = require('express');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env

const authRoutes = require('./routes/auth');

const app = express();

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173', // Allow frontend origin
    credentials: true,
}));
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', message: 'Backend is running smoothly' });
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});