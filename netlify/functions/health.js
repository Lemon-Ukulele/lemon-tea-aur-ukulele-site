const { json } = require("./_proxy");

exports.handler = async () => {
  return json(200, {
    ok: true,
    service: "lemon-tea-netlify-app",
    message: "Netlify functions are running.",
    timestamp: new Date().toISOString(),
  });
};
