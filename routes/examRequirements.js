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

// GET all exam requirements + examples, with optional filter by coordinator
router.get('/', async (req, res) => {
    try {
        const { coordinator_name, coordinator_id } = req.query;
        let query = 'SELECT *, false as is_example FROM exam_requirements';
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

        const { rows: realRows } = await db.query(query, params);
        
        // Fetch the 4 view-only example rows from our new table
        const { rows: exampleRows } = await db.query('SELECT *, true as is_example FROM exam_requirements_examples ORDER BY id ASC');

        // Prepend examples so they appear at the top (Rows 2 to 5 on the frontend grid)
        res.json([...exampleRows, ...realRows]);
    } catch (err) {
        console.error('Error fetching exam requirements:', err);
        res.status(500).json({ error: 'Failed to fetch exam requirements' });
    }
});

// POST /sync - Bulk sync all rows from the Live Excel sheet/Frontend
router.post('/sync', async (req, res) => {
    await adjustSchemaConstraints();

    // Now accepting deleted_ids from the frontend to fix the resurrection bug
    const { rows, updateCourses, deleted_ids } = req.body;
    
    if (!Array.isArray(rows)) {
        return res.status(400).json({ error: 'Invalid payload: rows array required' });
    }

    try {
        await db.query('BEGIN');

        // 1. Process deletions FIRST so they don't come back
        if (deleted_ids && Array.isArray(deleted_ids) && deleted_ids.length > 0) {
            const validDeletedIds = deleted_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
            if (validDeletedIds.length > 0) {
                await db.query(`DELETE FROM exam_requirements WHERE id = ANY($1::int[])`, [validDeletedIds]);
            }
        }

        const savedRows = [];

        // 2. Process Inserts and Updates
        for (const row of rows) {
            // SAFEGUARD: Never process or save the example rows into the main table
            if (row.is_example) continue;

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

            const numericId = parseInt(id, 10);

            if (numericId && !isNaN(numericId) && numericId > 0) {
                const updateRes = await db.query(`
                    UPDATE exam_requirements
                    SET coordinator_name = $1, coordinator_id = $2, coordinator_email = $3, semester = $4,
                        course_name = $5, course_code = $6, is_conducted = $7, course_type = $8,
                        exam_mode = $9, exam_weightage = $10, duration = $11, remark = $12,
                        is_reexam = $13, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $14
                    RETURNING *
                `, [
                    coordinator_name || null, coordinator_id || null, coordinator_email || null, semester || null,
                    course_name || null, course_code || null, is_conducted || 'Yes', course_type || 'Regular',
                    exam_mode || 'Written', exam_weightage !== undefined && exam_weightage !== null ? exam_weightage.toString() : '20',
                    duration || '1', remark || '', Boolean(is_reexam), numericId
                ]);

                if (updateRes.rows.length > 0) {
                    savedRows.push(updateRes.rows[0]);
                } else {
                    const insertRes = await db.query(`
                        INSERT INTO exam_requirements
                        (coordinator_name, coordinator_id, coordinator_email, semester, course_name, course_code, is_conducted, course_type, exam_mode, exam_weightage, duration, remark, is_reexam)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                        RETURNING *
                    `, [
                        coordinator_name || null, coordinator_id || null, coordinator_email || null, semester || null,
                        course_name || null, course_code || null, is_conducted || 'Yes', course_type || 'Regular',
                        exam_mode || 'Written', exam_weightage !== undefined && exam_weightage !== null ? exam_weightage.toString() : '20',
                        duration || '1', remark || '', Boolean(is_reexam)
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
                    coordinator_name || null, coordinator_id || null, coordinator_email || null, semester || null,
                    course_name || null, course_code || null, is_conducted || 'Yes', course_type || 'Regular',
                    exam_mode || 'Written', exam_weightage !== undefined && exam_weightage !== null ? exam_weightage.toString() : '20',
                    duration || '1', remark || '', Boolean(is_reexam)
                ]);
                savedRows.push(insertRes.rows[0]);
            }

            if (updateCourses && course_code) {
                const normalizedExamType = is_conducted?.toLowerCase() === 'no' ? 'exempt' : 'standard';
                try {
                    await db.query(`
                        UPDATE courses
                        SET exam_type = $1, course_type = COALESCE($2, course_type), remarks = COALESCE($3, remarks)
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

router.post('/', async (req, res) => {
    // Single insert remains the same
    await adjustSchemaConstraints();
    const body = req.body;
    try {
        const { rows } = await db.query(`
            INSERT INTO exam_requirements
            (coordinator_name, coordinator_id, coordinator_email, semester, course_name, course_code, is_conducted, course_type, exam_mode, exam_weightage, duration, remark, is_reexam)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
        `, [
            body.coordinator_name || null, body.coordinator_id || null, body.coordinator_email || null, body.semester || null,
            body.course_name || null, body.course_code || null, body.is_conducted || 'Yes', body.course_type || 'Regular',
            body.exam_mode || 'Written', body.exam_weightage !== undefined && body.exam_weightage !== null ? body.exam_weightage.toString() : '20',
            body.duration || '1', body.remark || '', Boolean(body.is_reexam)
        ]);
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to add exam requirement' });
    }
});

router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM exam_requirements WHERE id = $1', [id]);
        res.json({ message: 'Exam requirement deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete exam requirement' });
    }
});

module.exports = router;