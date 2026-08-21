const { Pool } = require('pg');
require('dotenv').config();

// Initialize the connection pool using the connection string from neon
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Neon DB hosted instances
    }
});

// Test the connection
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Error acquiring client for database connection:', err.stack);
    }
    console.log('Successfully connected to the PostgreSQL database on Neon.');
    release(); // Release the client back to the pool
});

module.exports = pool;