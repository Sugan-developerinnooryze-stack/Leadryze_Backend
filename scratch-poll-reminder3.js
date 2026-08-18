require('dotenv').config();
const mongoose = require('mongoose');
async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const meetingId = new mongoose.Types.ObjectId('6a82c101d7a36ca609fbf455');
  // Wait long enough to cover several cron ticks past the send window.
  await new Promise(r => setTimeout(r, 8 * 60 * 1000));
  const m = await db.collection('crm_meetings').findOne({ _id: meetingId });
  const logs = await db.collection('notification_email_logs').find({ sourceId: meetingId.toString() }).toArray();
  console.log('reminderSentAt:', m.reminderSentAt);
  console.log('Email log count:', logs.length);
  logs.forEach(l => console.log(' -', l.channel, l.status, l.sentAt));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
