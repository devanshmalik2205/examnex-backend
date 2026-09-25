const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Helper to drop strict constraints to allow new values like "MCQ Quiz" dynamically
const adjustSchemaConstraints = async () => {
    try {
        await db.query('ALTER TABLE exam_requirements DROP CONSTRAINT IF EXISTS exam_requirements_exam_mode_check;');
        await db.query('ALTER TABLE exam_requirements DROP CONSTRAINT IF EXISTS chk_exam_mode;');
        // Cast to VARCHAR safely in case it was created as an ENUM type previously
        await db.query('ALTER TABLE exam_requirements ALTER COLUMN exam_mode TYPE VARCHAR(255) USING exam_mode::text;');
    } catch (e) {
        // Ignore if constraints don't exist or column is already correctly typed
    }
};

// GET all exam requirements, with optional filter by coordinator
router.get('/', async (req, res) => {
    try {
        const { coordinator_name, coordinator_id } = req.query;
        let query = 'SELECT * FROM exam_requirements';
        let params = [];

        if (coordinator_id) {
            query += ' WHERE coordinator_id = $1 ORDER BY id ASC';
            params.push(coordinator_id);
        } else if (coordinator_name) {
            query += ' WHERE LOWER(coordinator_name) = LOWER($1) ORDER BY id ASC';
            params.push(coordinator_name);
        } else {
            query += ' ORDER BY id ASC';
        }

        const { rows } = await db.query(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching exam requirements:', err);
        res.status(500).json({ error: 'Failed to fetch exam requirements' });
    }
});

// POST /sync - Bulk sync all rows from the Live Excel sheet
router.post('/sync', async (req, res) => {
    // Ensure the database accepts new categories like "MCQ Quiz" before inserting
    await adjustSchemaConstraints();

    const { rows, updateCourses } = req.body;
    if (!Array.isArray(rows)) {
        return res.status(400).json({ error: 'Invalid payload: rows array required' });
    }

    try {
        await db.query('BEGIN');

        const savedRows = [];

        for (const row of rows) {
            const {
                id,
                coordinator_name,
                coordinator_id,
                coordinator_email,
                semester,
                course_name,
                course_code,
                is_conducted,
                course_type,
                exam_mode,
                exam_weightage,
                duration,
                remark,
                is_reexam
            } = row;

            // FIX: Safely parse ID from frontend to prevent false inserts when ID is a string ("1" vs 1)
            const numericId = parseInt(id, 10);

            if (numericId && !isNaN(numericId) && numericId > 0) {
                const updateRes = await db.query(`
                    UPDATE exam_requirements
                    SET coordinator_name = $1,
                        coordinator_id = $2,
                        coordinator_email = $3,
                        semester = $4,
                        course_name = $5,
                        course_code = $6,
                        is_conducted = $7,
                        course_type = $8,
                        exam_mode = $9,
                        exam_weightage = $10,
                        duration = $11,
                        remark = $12,
                        is_reexam = $13,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $14
                    RETURNING *
                `, [
                    coordinator_name || null,
                    coordinator_id || null,
                    coordinator_email || null,
                    semester || null,
                    course_name || null,
                    course_code || null,
                    is_conducted || 'Yes',
                    course_type || 'Regular',
                    exam_mode || 'Written', // Will now accept "MCQ Quiz"
                    exam_weightage !== undefined && exam_weightage !== null ? exam_weightage.toString() : '20',
                    duration || '1',
                    remark || '',
                    Boolean(is_reexam),
                    numericId
                ]);

                if (updateRes.rows.length > 0) {
                    savedRows.push(updateRes.rows[0]);
                } else {
                    // Fallback to insert if the ID somehow doesn't exist in the DB
                    const insertRes = await db.query(`
                        INSERT INTO exam_requirements
                        (coordinator_name, coordinator_id, coordinator_email, semester, course_name, course_code, is_conducted, course_type, exam_mode, exam_weightage, duration, remark, is_reexam)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                        RETURNING *
                    `, [
                        coordinator_name || null,
                        coordinator_id || null,
                        coordinator_email || null,
                        semester || null,
                        course_name || null,
                        course_code || null,
                        is_conducted || 'Yes',
                        course_type || 'Regular',
                        exam_mode || 'Written',
                        exam_weightage !== undefined && exam_weightage !== null ? exam_weightage.toString() : '20',
                        duration || '1',
                        remark || '',
                        Boolean(is_reexam)
                    ]);
                    savedRows.push(insertRes.rows[0]);
                }
            } else {
                const insertRes = await db.query(`
                    INSERT INTO exam_requirements
                    (coordinator_name, coordinator_id, coordinator_email, semester, course_name, course_code, is_conducted, course_type, exam_mode, exam_weightage, duration, remark, is_reexam)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                    RETURNING *
                `, [
                    coordinator_name || null,
                    coordinator_id || null,
                    coordinator_email || null,
                    semester || null,
                    course_name || null,
                    course_code || null,
                    is_conducted || 'Yes',
                    course_type || 'Regular',
                    exam_mode || 'Written',
                    exam_weightage !== undefined && exam_weightage !== null ? exam_weightage.toString() : '20',
                    duration || '1',
                    remark || '',
                    Boolean(is_reexam)
                ]);
                savedRows.push(insertRes.rows[0]);
            }

            // Sync with courses table if course_code is provided
            if (updateCourses && course_code) {
                const normalizedExamType = is_conducted?.toLowerCase() === 'no' ? 'exempt' : 'standard';
                try {
                    await db.query(`
                        UPDATE courses
                        SET exam_type = $1,
                            course_type = COALESCE($2, course_type),
                            remarks = COALESCE($3, remarks)
                        WHERE UPPER(REPLACE(course_code, '-', '')) = UPPER(REPLACE($4, '-', ''))
                    `, [normalizedExamType, course_type || null, remark || null, course_code]);
                } catch (courseErr) {
                    console.warn(`Could not sync course table for ${course_code}:`, courseErr.message);
                }
            }
        }

        await db.query('COMMIT');
        res.json({ success: true, count: savedRows.length, rows: savedRows });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error('Error syncing exam requirements:', err);
        res.status(500).json({ error: 'Failed to sync exam requirements' });
    }
});

// POST single row
router.post('/', async (req, res) => {
    await adjustSchemaConstraints();
    
    const {
        coordinator_name,
        coordinator_id,
        coordinator_email,
        semester,
        course_name,
        course_code,
        is_conducted,
        course_type,
        exam_mode,
        exam_weightage,
        duration,
        remark,
        is_reexam
    } = req.body;

    try {
        const { rows } = await db.query(`
            INSERT INTO exam_requirements
            (coordinator_name, coordinator_id, coordinator_email, semester, course_name, course_code, is_conducted, course_type, exam_mode, exam_weightage, duration, remark, is_reexam)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
        `, [
            coordinator_name || null,
            coordinator_id || null,
            coordinator_email || null,
            semester || null,
            course_name || null,
            course_code || null,
            is_conducted || 'Yes',
            course_type || 'Regular',
            exam_mode || 'Written',
            exam_weightage !== undefined && exam_weightage !== null ? exam_weightage.toString() : '20',
            duration || '1',
            remark || '',
            Boolean(is_reexam)
        ]);

        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Error adding exam requirement:', err);
        res.status(500).json({ error: 'Failed to add exam requirement' });
    }
});

// DELETE single row
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM exam_requirements WHERE id = $1', [id]);
        res.json({ message: 'Exam requirement deleted successfully' });
    } catch (err) {
        console.error('Error deleting exam requirement:', err);
        res.status(500).json({ error: 'Failed to delete exam requirement' });
    }
});

module.exports = router;