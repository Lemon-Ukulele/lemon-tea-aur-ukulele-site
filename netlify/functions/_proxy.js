function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
    body: JSON.stringify(data),
  };
}

async function proxyToBackend(event, backendPath) {
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }

  const base = process.env.FASTAPI_BASE_URL;
  if (!base) {
    return json(503, {
      ok: false,
      error: "FASTAPI_BASE_URL is not configured.",
      hint: "Set FASTAPI_BASE_URL in Netlify Site settings > Environment variables.",
    });
  }

  const url = `${base.replace(/\/$/, "")}${backendPath}`;
  const headers = {};
  const contentType = event.headers["content-type"] || event.headers["Content-Type"];
  const authorization = event.headers.authorization || event.headers.Authorization;

  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  if (authorization) {
    headers.Authorization = authorization;
  }

  const body =
    event.httpMethod === "GET" || event.body == null
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;

  try {
    const res = await fetch(url, {
      method: event.httpMethod,
      headers,
      body,
    });

    const text = await res.text();
    return {
      statusCode: res.status,
      headers: {
        "Content-Type": res.headers.get("content-type") || "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: text,
    };
  } catch (err) {
    return json(502, {
      ok: false,
      error: "Backend unreachable",
      details: String(err?.message || err),
      backend: base,
      path: backendPath,
    });
  }
}

module.exports = { json, proxyToBackend };
