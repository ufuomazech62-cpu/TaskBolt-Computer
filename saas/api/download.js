/**
 * Download endpoint — redirects to latest GitHub release
 */

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  
  // Redirect to latest release download
  res.redirect(302, "https://github.com/ufuomazech62-cpu/TaskBolt-Computer/releases/latest/download/TaskBolt_0.1.0_x64-setup.exe");
};
