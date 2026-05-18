const { proxyToBackend } = require("./_proxy");

exports.handler = async (event) => {
  return proxyToBackend(event, "/api/arrange");
};
