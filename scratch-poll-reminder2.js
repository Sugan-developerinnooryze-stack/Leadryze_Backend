require('dotenv').config();
const mongoose = require('mongoose');
async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const meetingId = new mongoose.Types.ObjectId('6a82be47fe082ee84c778b85');
  // Wait through at least 2 more cron ticks (2 min each) past the first send.
  await new Promise(r => setTimeout(r, 5 * 60 * 1000));
  const logs = await db.collection('notification_email_logs').find({ sourceId: meetingId.toString() }).toArray();
  console.log('Email log count after waiting 5 more minutes:', logs.length);
  logs.forEach(l => console.log(' -', l.channel, l.status, l.sentAt));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
