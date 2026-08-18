require('dotenv').config();
const mongoose = require('mongoose');
async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const meetingId = new mongoose.Types.ObjectId('6a82be47fe082ee84c778b85');
  for (let i = 0; i < 30; i++) {
    const m = await db.collection('crm_meetings').findOne({ _id: meetingId });
    if (m.reminderSentAt) {
      console.log('Reminder sent at:', m.reminderSentAt);
      const logs = await db.collection('notification_email_logs').find({ sourceId: meetingId.toString() }).toArray();
      console.log('Email log count so far:', logs.length);
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  console.log('Timed out waiting for reminder to fire');
  process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
