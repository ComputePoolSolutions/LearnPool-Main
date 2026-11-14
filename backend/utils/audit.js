const LmsItem = require('../models/LmsItem');
// Best-effort audit trail entry; never blocks the action that triggered it.
module.exports = (user, data) => LmsItem.create({ type: 'audit-logs', owner: user._id, data }).catch(() => {});
