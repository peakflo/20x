const { app } = require('electron')
app.setName('20x')
app.setPath('userData', require('path').join(app.getPath('appData'), '20x'))
app.whenReady().then(() => {
  const Database = require('better-sqlite3')
  const path = require('path')
  const dbPath = path.join(app.getPath('userData'), 'pf-desktop.db')
  console.log('DB path:', dbPath)
  const db = new Database(dbPath)
  // List all tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
  console.log('Tables:', JSON.stringify(tables.map(t => t.name)))
  // Try settings if it exists
  if (tables.some(t => t.name === 'settings')) {
    const rows = db.prepare("SELECT * FROM settings WHERE key LIKE '%setup%'").all()
    console.log('Setup rows:', JSON.stringify(rows))
    db.prepare("DELETE FROM settings WHERE key IN ('setup_completed_version','setup_completed')").run()
    console.log('Deleted')
  } else {
    console.log('No settings table — flag not set yet, wizard will show on next launch')
  }
  db.close()
  app.quit()
})
