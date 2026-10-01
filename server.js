const express = require('express');
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const teacherRoutes = require('./routes/teachers');
const studentRoutes = require('./routes/students');
const courseRoutes = require('./routes/courses'); 
const examRequirementRoutes = require('./routes/examRequirements');
const settingsRoutes = require('./routes/settings'); // <-- Added settings route for editing window

const app = express();

// Create HTTP server for Socket.IO
const server = http.createServer(app);

// Initialize Socket.IO with CORS
const io = new Server(server, {
    cors: {
        origin: true, // Allow any origin to connect
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    }
});

// Middleware
app.use(cors({
    origin: true, 
    credentials: true,
}));
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/teachers', teacherRoutes);
app.use('/api/admin/students', studentRoutes);
app.use('/api/admin/courses', courseRoutes); 
app.use('/api/exam-requirements', examRequirementRoutes);
app.use('/api/admin/exam-requirements', examRequirementRoutes);
app.use('/api/settings', settingsRoutes); // <-- Mounted settings route

// Socket.IO Real-Time Editing Logic
io.on('connection', (socket) => {
    console.log(`User connected to live editor: ${socket.id}`);

    // Join the shared editing room
    socket.join('exam-requirements-room');

    // Broadcast cell updates to all other connected clients
    socket.on('edit-cell', (data) => {
        socket.to('exam-requirements-room').emit('cell-updated', data);
    });

    // Broadcast row additions
    socket.on('add-rows', (data) => {
        socket.to('exam-requirements-room').emit('rows-added', data);
    });

    // Broadcast row deletions
    socket.on('delete-rows', (data) => {
        socket.to('exam-requirements-room').emit('rows-deleted', data);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', message: 'Backend is running smoothly' });
});

const PORT = process.env.PORT || 5000;

// IMPORTANT: Use server.listen instead of app.listen to enable Socket.IO
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});