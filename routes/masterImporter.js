const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const db = require('../config/db');
const bcrypt = require('bcryptjs');

const upload = multer({ storage: multer.memoryStorage() });

// Helper to safely extract string from cell
const safeString = (val) => (val === undefined || val === null ? '' : val.toString().trim());

// Helper to normalize BMU Email
const enforceBMUEmail = (email, name) => {
    let base = safeString(email);
    if (!base && name) {
        base = name.replace(/^(Dr\.|Mr\.|Mrs\.|Ms\.|Prof\.)+/ig, '')
                   .replace(/[^a-zA-Z0-9\s]/g, '')
                   .trim().replace(/\s+/g, '.');
    }
    const prefix = base.split('@')[0].toLowerCase().replace(/[^a-z0-9.]/g, '');
    return prefix ? `${prefix}@bmu.edu.in` : '';
};

// 1. Preview Endpoint (Parses multiple sheets)
router.post('/upload-preview', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No Excel file provided' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        
        const extractedCourses = new Map();
        const extractedTeachers = new Map();
        
        for (const sheetName of workbook.SheetNames) {
            const worksheet = workbook.Sheets[sheetName];
            const rawData = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
            
            rawData.forEach((row) => {
                // Heuristics for Teachers
                const tName = safeString(row['Faculty Name'] || row['Faculty'] || row['Teacher'] || row['Employee Name'] || row['Name']);
                const tEmail = safeString(row['Email'] || row['Email ID']);
                const tRole = safeString(row['Designation'] || row['Role'] || row['Type']);
                
                if (tName) {
                    const email = enforceBMUEmail(tEmail, tName);
                    if (email && !extractedTeachers.has(email)) {
                        extractedTeachers.set(email, {
                            full_name: tName,
                            email: email,
                            teacher_type: tRole || 'Assistant Professor',
                            sheet_source: sheetName,
                            status: 'Pending Validation'
                        });
                    }
                }

                // Heuristics for Subjects / Courses
                const cCode = safeString(row['Course Code'] || row['Subject Code']);
                const cTitle = safeString(row['Course Title'] || row['Subject'] || row['Course Name']);
                const cCredits = safeString(row['Credits'] || row['Cr']);
                
                if (cCode || cTitle) {
                    const key = cCode || cTitle.toUpperCase();
                    if (!extractedCourses.has(key)) {
                        extractedCourses.set(key, {
                            course_code: cCode,
                            course_title: cTitle,
                            credits: cCredits,
                            sheet_source: sheetName,
                            status: 'Pending Validation'
                        });
                    }
                }
            });
        }

        res.json({
            preview: {
                teachers: Array.from(extractedTeachers.values()),
                courses: Array.from(extractedCourses.values())
            }
        });
    } catch (err) {
        console.error('Master Excel preview error:', err);
        res.status(500).json({ error: 'Failed to process Excel file.' });
    }
});

// 2. Commit Endpoint (Saves to DB)
router.post('/commit', async (req, res) => {
    const { teachers, courses } = req.body;
    
    try {
        await db.query('BEGIN');

        let teachersAdded = 0;
        let coursesAdded = 0;

        // Process Teachers
        if (teachers && Array.isArray(teachers)) {
            const salt = await bcrypt.genSalt(6);
            const defaultPassword = await bcrypt.hash('password123', salt);

            for (const t of teachers) {
                if (!t.full_name || !t.email) continue;
                const username = t.email.split('@')[0];
                try {
                    await db.query(`
                        INSERT INTO teachers (username, password, full_name, email, teacher_type)
                        VALUES ($1, $2, $3, $4, $5)
                        ON CONFLICT (email) DO UPDATE 
                        SET full_name = EXCLUDED.full_name, teacher_type = EXCLUDED.teacher_type
                    `, [username, defaultPassword, t.full_name, t.email, t.teacher_type || 'Assistant Professor']);
                    teachersAdded++;
                } catch (e) {
                    console.error('Teacher Insert Error:', e.message);
                }
            }
        }

        // Process Courses
        if (courses && Array.isArray(courses)) {
            for (const c of courses) {
                if (!c.course_title) continue;
                try {
                    await db.query(`
                        INSERT INTO courses (course_code, course_title, credits)
                        VALUES ($1, $2, $3)
                        ON CONFLICT (course_code) DO UPDATE 
                        SET course_title = EXCLUDED.course_title, credits = EXCLUDED.credits
                    `, [c.course_code || null, c.course_title, c.credits ? parseFloat(c.credits) : null]);
                    coursesAdded++;
                } catch (e) {
                    console.error('Course Insert Error:', e.message);
                }
            }
        }

        await db.query('COMMIT');
        res.json({ 
            success: true, 
            message: 'Master import completed successfully',
            summary: { teachers: teachersAdded, courses: coursesAdded }
        });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error('Master Import Commit Error:', err);
        res.status(500).json({ error: 'Failed to save imported data to the database' });
    }
});

module.exports = router;