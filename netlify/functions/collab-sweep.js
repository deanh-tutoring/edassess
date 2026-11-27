// Runs every minute. For classes that share a teacher folder, it makes the class owner the owner of any file a
// co-teacher added, refreshes the file list and moves posted classwork files to the student folder.
// It uses the class owner's one-time Google grant, so nobody has to be signed in.
const { schedule } = require('@netlify/functions');
const data = require('./data.js');
exports.handler = schedule('* * * * *', async () => {
  try { await data.sweepAll(); } catch (e) { console.log('collab sweep failed:', e && e.message); }
  return { statusCode: 200 };
});
