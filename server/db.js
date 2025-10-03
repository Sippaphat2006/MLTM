const mysql = require('mysql2');

// สร้าง Connection Pool แยกสำหรับแต่ละ Database
const databases = {
  db_mltm: mysql.createPool({
    host: '192.168.0.233',
    user: 'root',
    password: 'castem300',
    database: 'mltm',
    waitForConnections: true,
    connectionLimit: 10,
    //port: 8081,
    queueLimit: 0
  }).promise(),

  /*
  db_maintenance: mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'castem300',
    database: 'maintenance',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  }).promise(),*/

};

// ฟังก์ชัน Query แบบเลือก Database
async function query(dbName, sql, params = []) {
  try {
    if (!databases[dbName]) throw new Error(`Database ${dbName} not found`);
    const [results] = await databases[dbName].query(sql, params);
    return results;
  } catch (err) {
    console.error(`Database Query Error [${dbName}]:`, err);
    throw err;
  }
}

// ปิด Connection Pool ทุก DB
async function close() {
  try {
    await Promise.all(Object.values(databases).map(db => db.end()));
    console.log('All database connections closed');
  } catch (err) {
    console.error('Error closing connections:', err);
  }
}

module.exports = {
  query,
  close
};
