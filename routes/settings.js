const express = require('express');
const router = express.Router();
const db = require('../config/db');

// GET current editing window
router.get('/exam_req_window', async (req, res) => {
    try {
        const { rows } = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'exam_req_window'");
        if (rows.length > 0) {
            res.json(rows[0].setting_value);
        } else {
            res.json({ start_date: '', end_date: '' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// POST update editing window (Admin Only in production)
router.post('/exam_req_window', async (req, res) => {
    const { start_date, end_date } = req.body;
    try {
        const value = JSON.stringify({ start_date, end_date });
        await db.query(
            "INSERT INTO system_settings (setting_key, setting_value) VALUES ('exam_req_window', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1",
            [value]
        );
        res.json({ success: true, start_date, end_date });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

module.exports = router;