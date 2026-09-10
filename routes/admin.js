const express = require('express');
const router = express.Router();
const db = require('../config/db');
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');

const upload = multer({ storage: multer.memoryStorage() });

const dropTeacherConstraint = async () => {
    try {
        await db.query('ALTER TABLE teachers DROP CONSTRAINT IF EXISTS teachers_teacher_type_check;');
    } catch (e) {}
};

const cleanTeacherName = (name) => {
    if (!name) return '';
    let cleaned = name.trim().replace(/^(With\s+|And\s+)/i, '');
    const prefixRegex = /^(Dr\.|Dr\s|Mr\.|Mr\s|Mrs\.|Mrs\s|Ms\.|Ms\s|Prof\.|Prof\s|Er\.|Er\s)+/i;
    while (prefixRegex.test(cleaned)) {
        cleaned = cleaned.replace(prefixRegex, '').trim();
    }
    return cleaned;
};

const parseTeachersList = (rawString) => {
    if (!rawString) return [];
    const parts = rawString.split(/\s+and\s+|\s*&\s*|\s*\/\s*|,/i);
    return parts.map(p => cleanTeacherName(p)).filter(p => p.length > 0);
};

const generateBMUEmail = (fullName) => {
    if (!fullName) return '';
    let cleanName = fullName.replace(/^(Dr\.|Dr\s|Mr\.|Mr\s|Mrs\.|Mrs\s|Ms\.|Ms\s|Prof\.|Prof\s|Er\.|Er\s)+/ig, '').trim();
    cleanName = cleanName.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '.').toLowerCase();
    return `${cleanName}@bmu.edu.in`;
};

const parseTimeHeader = (str) => {
    const normalizedStr = str.replace(/[\n\r]/g, ' ');
    const match = normalizedStr.match(/(\d{1,2}:\d{2})\s*([AP]M)?\s*-\s*(\d{1,2}:\d{2})\s*([AP]M)?/i);
    if (!match) return null;
    let [_, startT, startM, endT, endM] = match;
    if (!startM) startM = endM; 
    const to24 = (time, mod) => {
        let [h, m] = time.split(':');
        h = parseInt(h, 10);
        if (mod && mod.toUpperCase() === 'PM' && h !== 12) h += 12;
        if (mod && mod.toUpperCase() === 'AM' && h === 12) h = 0;
        return `${h.toString().padStart(2, '0')}:${m}:00`;
    };
    try { return { start: to24(startT, startM), end: to24(endT, endM) }; } catch(e) { return null; }
};

router.get('/stats', async (req, res) => {
    try {
        const examsResult = await db.query('SELECT COUNT(DISTINCT course_id) as total FROM timetable_entries');
        const studentsResult = await db.query('SELECT COUNT(*) as total FROM students');
        const roomsResult = await db.query('SELECT COUNT(DISTINCT room) as total FROM timetable_entries WHERE room IS NOT NULL');
        const clashesResult = await db.query(`
            SELECT COUNT(*) as total FROM timetable_entries t1 JOIN timetable_entries t2 ON t1.room = t2.room AND t1.day_of_week = t2.day_of_week AND t1.id != t2.id
            WHERE t1.start_time < t2.end_time AND t1.end_time > t2.start_time
        `);
        res.json({
            total_exams: parseInt(examsResult.rows[0].total) || 0,
            total_students: parseInt(studentsResult.rows[0].total) || 0,
            total_rooms: parseInt(roomsResult.rows[0].total) || 0,
            conflicts: Math.floor((parseInt(clashesResult.rows[0].total) || 0) / 2)
        });
    } catch (err) { res.status(500).json({ message: 'Internal Server Error' }); }
});

router.get('/timetables', async (req, res) => {
    try {
        const { rows } = await db.query(`SELECT id, batch_year, stream, semester, source_sheet FROM timetables ORDER BY batch_year DESC, stream ASC, semester ASC;`);
        res.json(rows);
    } catch (err) { res.status(500).json({ message: 'Internal Server Error' }); }
});

router.post('/timetables', async (req, res) => {
    const { batch_year, stream, semester } = req.body;
    try {
        const { rows } = await db.query('INSERT INTO timetables (batch_year, stream, semester) VALUES ($1, $2, $3) RETURNING *', [batch_year, stream, semester]);
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'This specific Batch, Stream, and Semester combination already exists.' });
        res.status(500).json({ error: 'Failed to create section.' });
    }
});

router.delete('/timetables/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('BEGIN');
        await db.query('DELETE FROM timetable_entries WHERE timetable_id = $1', [id]);
        await db.query('DELETE FROM timetable_course_teachers WHERE timetable_id = $1', [id]);
        await db.query('DELETE FROM student_timetable WHERE timetable_id = $1', [id]);
        await db.query('DELETE FROM timetables WHERE id = $1', [id]);
        await db.query('COMMIT');
        res.json({ message: 'Section deleted successfully.' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to delete section.' });
    }
});

router.get('/timetables/:id', async (req, res) => {
    const timetableId = req.params.id;
    try {
        const ttInfo = await db.query('SELECT batch_year, stream FROM timetables WHERE id = $1', [timetableId]);
        if (ttInfo.rows.length > 0) {
            const { batch_year, stream } = ttInfo.rows[0];
            const yearPrefix = batch_year.toString().substring(2, 4); 
            
            await db.query(`
                INSERT INTO student_timetable (student_id, timetable_id)
                SELECT id, $1 FROM students
                WHERE registration_no LIKE $2 AND UPPER(TRIM(stream)) = UPPER(TRIM($3))
                ON CONFLICT DO NOTHING
            `, [timetableId, `${yearPrefix}%`, stream]);
        }

        const entriesQuery = `
            SELECT 
                te.id AS entry_id, te.day_of_week, te.start_time, te.end_time, te.room, te.entry_type, te.raw_entry,
                c.id AS course_id, c.course_code, c.abbreviation, c.course_title, c.category, c.sub_category, c.credits, c.ldp, c.course_type,
                (
                    SELECT json_agg(json_build_object('id', t.id, 'full_name', t.full_name, 'email', t.email, 'type', t.teacher_type))
                    FROM timetable_course_teachers tct
                    JOIN teachers t ON tct.teacher_id = t.id
                    WHERE tct.course_id = c.id AND tct.timetable_id = $1
                ) AS teachers
            FROM timetable_entries te
            LEFT JOIN courses c ON te.course_id = c.id
            WHERE te.timetable_id = $1
            ORDER BY te.start_time ASC;
        `;
        const { rows: entries } = await db.query(entriesQuery, [timetableId]);

        const studentsQuery = `
            SELECT s.id, s.registration_no, s.username, s.stream, s.email
            FROM students s JOIN student_timetable st ON s.id = st.student_id WHERE st.timetable_id = $1 ORDER BY s.registration_no ASC;
        `;
        const { rows: students } = await db.query(studentsQuery, [timetableId]);

        res.json({ entries, students, stats: { total_classes: entries.length, total_students: students.length } });
    } catch (err) {
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

router.post('/timetables/:id/upload-preview', upload.single('file'), async (req, res) => {
    const timetableId = req.params.id;
    if (!req.file) return res.status(400).json({ error: 'No Excel file provided' });

    try {
        const overwriteCheckAllocations = await db.query('SELECT COUNT(*) as count FROM timetable_course_teachers WHERE timetable_id = $1', [timetableId]);
        const overwriteCheckEntries = await db.query('SELECT COUNT(*) as count FROM timetable_entries WHERE timetable_id = $1', [timetableId]);
        
        const totalAllocationsDeleted = parseInt(overwriteCheckAllocations.rows[0].count) || 0;
        const totalEntriesDeleted = parseInt(overwriteCheckEntries.rows[0].count) || 0;

        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });

        let timeHeaders = [];
        let listHeaders = {};
        
        for (let r = 0; r < Math.min(15, rawData.length); r++) {
            const row = rawData[r];
            for (let c = 0; c < row.length; c++) {
                const cell = row[c].toString().trim();
                if (!cell) continue;
                
                const tMatch = parseTimeHeader(cell);
                if (tMatch) { timeHeaders.push({ colIndex: c, start: tMatch.start, end: tMatch.end }); }
                
                const cUpper = cell.toUpperCase();
                if (cUpper.includes('COURSE CODE')) listHeaders['Course Code'] = c;
                if (cUpper.includes('TITLE ABBR') || cUpper === 'ABBREVIATION') listHeaders['Course Title Abbr'] = c;
                if (cUpper === 'COURSE' || cUpper === 'COURSE TITLE') listHeaders['Course'] = c;
                if (cUpper === 'COURSE FACULTY' || cUpper.includes('FACULTY NAME')) listHeaders['Course Faculty'] = c;
                if (cUpper === 'CATEGORY') listHeaders['Category'] = c;
                if (cUpper === 'CREDITS') listHeaders['Credits'] = c;
                if (cUpper === 'LDP') listHeaders['LDP'] = c;
            }
        }

        const abbrToCode = {};
        const courses = new Map();
        const allocations = [];
        const entries = []; 
        const minorCodes = []; // Track minor courses specifically

        if (listHeaders['Course Code']) {
            for (let r = 0; r < rawData.length; r++) {
                const row = rawData[r];
                const cCode = row[listHeaders['Course Code']]?.toString().trim();
                if (!cCode || cCode.toUpperCase() === 'COURSE CODE') continue;

                const cTitle = row[listHeaders['Course']]?.toString().trim() || cCode;
                const abbr = row[listHeaders['Course Title Abbr']]?.toString().trim();
                const category = row[listHeaders['Category']]?.toString().trim();
                const credits = row[listHeaders['Credits']]?.toString().trim();
                const ldp = row[listHeaders['LDP']]?.toString().trim();

                if (abbr) abbrToCode[abbr] = cCode;

                // Check if this course is categorized as a Minor
                let isMinor = false;
                if (
                    (cTitle && cTitle.toLowerCase().includes('minor')) || 
                    (category && category.toLowerCase().includes('minor')) ||
                    (abbr && abbr.toLowerCase().includes('minor'))
                ) {
                    isMinor = true;
                    minorCodes.push(cCode);
                }

                if (!courses.has(cCode)) {
                    courses.set(cCode, { 
                        course_code: cCode, course_title: cTitle, abbreviation: abbr, 
                        category, credits, ldp, 
                        course_type: isMinor ? 'minor' : 'regular' 
                    });
                }

                const rawFaculty = row[listHeaders['Course Faculty']]?.toString().trim();
                if (rawFaculty) {
                    const fNames = parseTeachersList(rawFaculty);
                    fNames.forEach(fName => {
                        const fEmail = generateBMUEmail(fName);
                        allocations.push({ course_code: cCode, faculty_name: fName, faculty_email: fEmail });
                    });
                }
            }
        }

        if (timeHeaders.length > 0) {
            const validDays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
            for (let r = 0; r < rawData.length; r++) {
                const row = rawData[r];
                const firstCell = (row[0] || '').toString().trim().toUpperCase() || (row[1] || '').toString().trim().toUpperCase();
                const matchedDay = validDays.find(d => firstCell === d || firstCell.startsWith(d));
                
                if (!matchedDay) continue;

                timeHeaders.forEach(th => {
                    const cellVal = row[th.colIndex]?.toString().trim();
                    if (!cellVal) return;

                    if (cellVal.toUpperCase() === 'LUNCH' || cellVal.toUpperCase().includes('LUNCH')) {
                        entries.push({ day_of_week: matchedDay.substring(0,3), start_time: th.start, end_time: th.end, course_code: null, room: null, raw_entry: 'LUNCH', entry_type: 'LUNCH' });
                        return;
                    }

                    // If cell just says "Minor", expand it into all extracted minor subjects so they link properly
                    if (cellVal.toUpperCase() === 'MINOR' || cellVal.toUpperCase().includes('MINOR (NANO TECH)')) {
                        if (minorCodes.length > 0) {
                            minorCodes.forEach(mCode => {
                                entries.push({ 
                                    day_of_week: matchedDay.substring(0,3), start_time: th.start, end_time: th.end, 
                                    course_code: mCode, room: 'TBA', raw_entry: 'Minor' 
                                });
                            });
                        } else {
                            entries.push({ day_of_week: matchedDay.substring(0,3), start_time: th.start, end_time: th.end, course_code: null, room: 'TBA', raw_entry: cellVal });
                        }
                        return;
                    }

                    const classes = cellVal.split(/\n|\/|\|/);
                    classes.forEach(clsStr => {
                        const cls = clsStr.trim();
                        if (!cls) return;

                        let guessedCode = null;
                        let guessedRoom = 'TBA';
                        
                        const roomMatch = cls.match(/\b([A-Z]{2}\s?\d{3}[A-Z]?|WORKSHOP|MDC|MPH)\b/i);
                        if (roomMatch) {
                            guessedRoom = roomMatch[1].toUpperCase();
                        } else if (cls.match(/\bLAB\b/i)) {
                            guessedRoom = 'LAB';
                        }

                        for (const [abbr, code] of Object.entries(abbrToCode)) {
                            if (cls.toUpperCase().includes(abbr.toUpperCase())) { guessedCode = code; break; }
                        }
                        if (!guessedCode) {
                            const possibleCode = cls.split(' ')[0].toUpperCase();
                            if (courses.has(possibleCode)) guessedCode = possibleCode;
                        }

                        entries.push({ day_of_week: matchedDay.substring(0,3), start_time: th.start, end_time: th.end, course_code: guessedCode, room: guessedRoom, raw_entry: cls });
                    });
                });
            }
        }

        res.json({
            overwrites: { total_allocations_deleted: totalAllocationsDeleted, total_entries_deleted: totalEntriesDeleted },
            preview: { courses: Array.from(courses.values()), allocations: allocations, entries: entries }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to process Excel file. Ensure it matches the template.' });
    }
});

router.post('/timetables/:id/commit', async (req, res) => {
    const timetableId = req.params.id;
    const { courses, allocations, entries, isGlobalImport } = req.body; 

    await dropTeacherConstraint(); 

    try {
        await db.query('BEGIN');
        
        let targetTimetableIds = [timetableId];

        if (isGlobalImport) {
            const ttInfo = await db.query('SELECT batch_year, semester FROM timetables WHERE id = $1', [timetableId]);
            if (ttInfo.rows.length > 0) {
                const { batch_year, semester } = ttInfo.rows[0];
                const allMatching = await db.query('SELECT id FROM timetables WHERE batch_year = $1 AND semester = $2', [batch_year, semester]);
                targetTimetableIds = allMatching.rows.map(r => r.id);
            }
        }

        if (!isGlobalImport) {
            for (const tId of targetTimetableIds) {
                await db.query('DELETE FROM timetable_course_teachers WHERE timetable_id = $1', [tId]);
                if (entries && entries.length > 0) { 
                    await db.query('DELETE FROM timetable_entries WHERE timetable_id = $1', [tId]); 
                }
            }
        }

        // --- Courses ---
        const courseIdMap = {}; 
        const uniqueCoursesMap = {};
        for (const c of (courses || [])) {
            if (!c.course_code) continue; 
            uniqueCoursesMap[c.course_code.toUpperCase()] = c; 
        }

        for (const c of Object.values(uniqueCoursesMap)) {
            const cTitle = c.course_title || c.course_code;
            const creditsVal = (c.credits && !isNaN(parseFloat(c.credits))) ? parseFloat(c.credits) : null;
            let cRes = await db.query('SELECT id FROM courses WHERE UPPER(course_code) = $1', [c.course_code.toUpperCase()]);
            
            if (cRes.rows.length > 0) {
                courseIdMap[c.course_code] = cRes.rows[0].id;
                try { await db.query('UPDATE courses SET course_title = $1, category = $2, abbreviation = $3, credits = $4, ldp = $5, course_type = $6 WHERE id = $7', [cTitle, c.category || 'General', c.abbreviation || null, creditsVal, c.ldp || null, c.course_type || 'regular', cRes.rows[0].id]); } catch(e) {}
            } else {
                try {
                    let newCRes = await db.query('INSERT INTO courses (course_code, course_title, category, abbreviation, credits, ldp, course_type) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [c.course_code.toUpperCase(), cTitle, c.category || 'General', c.abbreviation || null, creditsVal, c.ldp || null, c.course_type || 'regular']);
                    courseIdMap[c.course_code] = newCRes.rows[0].id;
                } catch(e) {
                    if (e.code === '23505') {
                        let fbRes = await db.query('SELECT id FROM courses WHERE UPPER(course_code) = $1 OR abbreviation = $2', [c.course_code.toUpperCase(), c.abbreviation]);
                        if (fbRes.rows.length > 0) courseIdMap[c.course_code] = fbRes.rows[0].id; else throw e;
                    } else throw e;
                }
            }
        }

        // --- Teachers ---
        const uniqueTeachersMap = {};
        for (const a of (allocations || [])) {
            if(!a.faculty_email || !a.faculty_name || !a.course_code) continue;
            const enforcedEmail = `${a.faculty_email.split('@')[0].trim().toLowerCase()}@bmu.edu.in`;
            if (!uniqueTeachersMap[enforcedEmail]) uniqueTeachersMap[enforcedEmail] = a.faculty_name;
        }

        const salt = await bcrypt.genSalt(6);
        const defaultPassword = await bcrypt.hash('password123', salt);
        const teacherIdMap = {};

        for (const [email, name] of Object.entries(uniqueTeachersMap)) {
            const username = email.split('@')[0];
            let tRes = await db.query('SELECT id FROM teachers WHERE LOWER(email) = $1 OR LOWER(username) = $2', [email, username]);
            let teacherId;
            
            if (tRes.rows.length > 0) {
                teacherId = tRes.rows[0].id;
                try { await db.query('UPDATE teachers SET full_name = $1 WHERE id = $2', [name, teacherId]); } catch(e) {} 
            } else {
                try {
                    let newTRes = await db.query('INSERT INTO teachers (username, password, full_name, email, teacher_type) VALUES ($1, $2, $3, $4, $5) RETURNING id', [username, defaultPassword, name, email, 'Assistant Prof.']);
                    teacherId = newTRes.rows[0].id;
                } catch (insertErr) {
                    if (insertErr.code === '23505') {
                        let fbRes = await db.query('SELECT id FROM teachers WHERE LOWER(full_name) = $1', [name.toLowerCase()]);
                        if (fbRes.rows.length > 0) {
                            teacherId = fbRes.rows[0].id;
                            try { await db.query('UPDATE teachers SET email = $1 WHERE id = $2', [email, teacherId]); } catch(e) {}
                        } else throw insertErr;
                    } else throw insertErr;
                }
            }
            teacherIdMap[email] = teacherId;
        }

        // --- Allocations (Apply to all target timetables) ---
        for (const tId of targetTimetableIds) {
            for (const a of (allocations || [])) {
                if(!a.faculty_email || !a.faculty_name || !a.course_code) continue;
                const enforcedEmail = `${a.faculty_email.split('@')[0].trim().toLowerCase()}@bmu.edu.in`;
                const teacherId = teacherIdMap[enforcedEmail];
                const courseId = courseIdMap[a.course_code];

                if (teacherId && courseId) {
                    const existCheck = await db.query('SELECT 1 FROM timetable_course_teachers WHERE teacher_id = $1 AND course_id = $2 AND timetable_id = $3', [teacherId, courseId, tId]);
                    if (existCheck.rows.length === 0) {
                        await db.query('INSERT INTO timetable_course_teachers (teacher_id, course_id, timetable_id) VALUES ($1, $2, $3)', [teacherId, courseId, tId]);
                    }
                }
            }
        }

        // --- Entries (Apply to all target timetables) ---
        if (entries && entries.length > 0) {
            for (const tId of targetTimetableIds) {
                for (const e of entries) {
                    if (!e.day_of_week || !e.start_time || !e.end_time) continue; 
                    const courseId = courseIdMap[e.course_code] || null;
                    const room = e.room || 'TBA';
                    const raw = e.raw_entry || e.course_code || 'Session';
                    const entryType = (raw === 'LUNCH' || e.entry_type === 'LUNCH') ? 'LUNCH' : 'CLASS';

                    if (isGlobalImport) {
                        await db.query(`DELETE FROM timetable_entries WHERE timetable_id = $1 AND day_of_week = $2 AND start_time = $3 AND (raw_entry ILIKE '%minor%' OR raw_entry = $4)`, [tId, e.day_of_week, e.start_time, raw]);
                    }

                    await db.query(`INSERT INTO timetable_entries (timetable_id, course_id, day_of_week, start_time, end_time, room, raw_entry, entry_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [tId, courseId, e.day_of_week, e.start_time, e.end_time, room, raw, entryType]);
                }
            }
        }

        const ttInfo = await db.query('SELECT batch_year, stream FROM timetables WHERE id = $1', [timetableId]);
        if (ttInfo.rows.length > 0) {
            const { batch_year, stream } = ttInfo.rows[0];
            const yearPrefix = batch_year.toString().substring(2, 4);
            await db.query(`
                INSERT INTO student_timetable (student_id, timetable_id)
                SELECT id, $1 FROM students WHERE registration_no LIKE $2 AND UPPER(TRIM(stream)) = UPPER(TRIM($3)) ON CONFLICT DO NOTHING
            `, [timetableId, `${yearPrefix}%`, stream]);
        }

        await db.query('COMMIT');
        res.json({ message: 'Curriculum, Allocations, and Schedule updated successfully.' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: err.detail || err.message || 'Failed to save changes to database' });
    }
});


// @route   POST /api/admin/schedule/generate-preview
// @desc    Automatically assigns subjects to available slots, detecting clashes
router.post('/schedule/generate-preview', async (req, res) => {
    const { startDate, endDate, slots } = req.body;
    
    if (!startDate || !endDate || !slots || slots.length === 0) {
        return res.status(400).json({ error: 'Please provide valid start/end dates and at least one slot.' });
    }

    try {
        // Fetch all courses assigned to any timetable (representing the subjects needing exams)
        // ONLY include standard exams, exclude projects and enrichments
        const mappingsQuery = `
            SELECT c.id as course_id, c.course_code, c.course_title, 
                   t.id as timetable_id, t.batch_year, t.stream, t.semester
            FROM timetable_course_teachers tct
            JOIN courses c ON tct.course_id = c.id
            JOIN timetables t ON tct.timetable_id = t.id
            WHERE c.exam_type = 'standard' OR c.exam_type IS NULL
        `;
        const { rows: mappings } = await db.query(mappingsQuery);

        if (mappings.length === 0) {
            return res.json({ schedule: [], clashes: [{ type: 'info', message: 'No courses found to schedule. Ensure timetables have subjects mapped.' }] });
        }

        // Group courses to see which batches take which course
        const courseMap = {};
        mappings.forEach(m => {
            if (!courseMap[m.course_id]) {
                courseMap[m.course_id] = { course_id: m.course_id, course_code: m.course_code, title: m.course_title, batches: [] };
            }
            // Prevent duplicate batch records for a single course
            const existingBatch = courseMap[m.course_id].batches.find(b => b.timetable_id === m.timetable_id);
            if (!existingBatch) {
                courseMap[m.course_id].batches.push({ timetable_id: m.timetable_id, name: `${m.stream} - Sem ${m.semester} (${m.batch_year})` });
            }
        });

        // Sort by difficulty (courses with more batches need to be scheduled first)
        const courses = Object.values(courseMap).sort((a, b) => b.batches.length - a.batches.length);

        // Generate all valid Datetime slots
        const start = new Date(startDate);
        const end = new Date(endDate);
        const availableSlots = [];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0]; // Format: YYYY-MM-DD
            slots.forEach(s => {
                availableSlots.push({ date: dateStr, slotName: s.name, startTime: s.startTime, endTime: s.endTime, id: `${dateStr}-${s.name}` });
            });
        }

        const schedule = [];
        const clashes = [];
        // Tracks occupied slots for a given batch. Format: { timetable_id: { slots: Set('date-slotName'), days: Set('date') } }
        const batchSchedule = {}; 

        // Core Generation Algorithm
        courses.forEach(course => {
            let assignedSlot = null;

            // Pass 1: Try to find a perfectly clean slot (No clash in exact slot AND no exam on the same day for these batches)
            for (const slot of availableSlots) {
                let hasClash = false;
                let sameDayConflict = false;

                for (const batch of course.batches) {
                    if (!batchSchedule[batch.timetable_id]) batchSchedule[batch.timetable_id] = { slots: new Set(), days: new Set() };
                    
                    if (batchSchedule[batch.timetable_id].slots.has(slot.id)) hasClash = true;
                    if (batchSchedule[batch.timetable_id].days.has(slot.date)) sameDayConflict = true; 
                }

                if (!hasClash && !sameDayConflict) {
                    assignedSlot = slot;
                    break;
                }
            }

            // Pass 2 (Fallback): Find a slot where there is NO EXACT CLASH, but allow multiple exams on the SAME DAY
            if (!assignedSlot) {
                for (const slot of availableSlots) {
                    let hasExactClash = false;
                    let conflictingBatches = [];

                    for (const batch of course.batches) {
                        if (batchSchedule[batch.timetable_id]?.slots.has(slot.id)) {
                            hasExactClash = true;
                            break;
                        }
                        // Check if THIS specific section already has an exam mapped on this day
                        if (batchSchedule[batch.timetable_id]?.days.has(slot.date)) {
                            conflictingBatches.push(batch.name);
                        }
                    }

                    // This prevents flagging independent sections doing the same exam as a conflict!
                    if (!hasExactClash) {
                        assignedSlot = slot;
                        
                        if (conflictingBatches.length > 0) {
                            const uniqueBatches = [...new Set(conflictingBatches)];
                            clashes.push({ 
                                type: 'warning', 
                                message: `Density Warning: ${uniqueBatches.join(', ')} have multiple different exams on ${slot.date} (Includes ${course.course_code}).` 
                            });
                        }
                        break;
                    }
                }
            }

            // Record assignment or report hard clash
            if (assignedSlot) {
                schedule.push({
                    id: `${course.course_code}-${assignedSlot.id}`,
                    course_id: course.course_id,
                    course_code: course.course_code,
                    title: course.title,
                    date: assignedSlot.date,
                    slotName: assignedSlot.slotName,
                    startTime: assignedSlot.startTime,
                    endTime: assignedSlot.endTime,
                    batches: course.batches
                });
                
                // Mark this slot and day as occupied for all associated batches
                course.batches.forEach(b => {
                    batchSchedule[b.timetable_id].slots.add(assignedSlot.id);
                    batchSchedule[b.timetable_id].days.add(assignedSlot.date);
                });
            } else {
                clashes.push({ type: 'error', message: `Severe Clash: Failed to auto-schedule ${course.course_code} - not enough conflict-free slots available in the date range.` });
            }
        });

        // Sort schedule chronologically before sending
        schedule.sort((a, b) => new Date(`${a.date}T${a.startTime}`) - new Date(`${b.date}T${b.startTime}`));

        res.json({ schedule, clashes });
    } catch (err) {
        console.error("Exam generation error:", err);
        res.status(500).json({ error: 'Server error during schedule generation.' });
    }
});

// @route   POST /api/admin/schedule/commit-generated
// @desc    Saves the generated exam schedule into timetable_entries
router.post('/schedule/commit-generated', async (req, res) => {
    const { schedule } = req.body;
    if (!schedule || schedule.length === 0) return res.status(400).json({ error: 'No schedule provided to commit.' });

    try {
        await db.query('BEGIN');
        
        for (const item of schedule) {
            for (const batch of item.batches) {
                // Insert into entries. We store the specific YYYY-MM-DD in day_of_week for exam differentiation
                await db.query(`
                    INSERT INTO timetable_entries 
                    (timetable_id, course_id, day_of_week, start_time, end_time, room, raw_entry, entry_type) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `, [
                    batch.timetable_id, 
                    item.course_id, 
                    item.date, 
                    item.startTime, 
                    item.endTime, 
                    'TBA', 
                    `${item.course_code} (Exam)`, 
                    'EXAM'
                ]);
            }
        }

        await db.query('COMMIT');
        res.json({ message: 'Exam schedule finalized and published to the database.' });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error("Exam commit error:", err);
        res.status(500).json({ error: err.message || 'Failed to save generated schedule.' });
    }
});

module.exports = router;