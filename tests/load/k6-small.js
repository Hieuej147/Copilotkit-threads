import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    thread_lists: {
      executor: "constant-vus",
      vus: 25,
      duration: "2m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

const baseUrl = __ENV.BASE_URL || "http://localhost:4000";

export default function () {
  const response = http.get(`${baseUrl}/v2/threads?limit=30`, {
    headers: {
      "x-auth-tenant-id": __ENV.TENANT_ID || "load-test",
      "x-auth-user-id": `user-${__VU % 100}`,
    },
  });
  check(response, { "list succeeds": (value) => value.status === 200 });
  sleep(1);
}
