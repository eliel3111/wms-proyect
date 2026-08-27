import axios from "axios";

import {
  getAdmCloudAuthHeader,
} from "./admcloud.auth.js";

const admcloudClient = axios.create({
  baseURL:
    process.env.ADMCLOUD_BASE_URL ||
    "https://api.admcloud.net/api",

  timeout: 20000,

  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
  },
});

admcloudClient.interceptors.request.use(
  (config) => {
    const company =
      process.env.ADMCLOUD_COMPANY;

    const role =
      process.env.ADMCLOUD_ROLE;

    const appid =
      process.env.ADMCLOUD_APP_ID;

    if (!company) {
      throw new Error(
        "ADMCLOUD_COMPANY is missing"
      );
    }

    if (!role) {
      throw new Error(
        "ADMCLOUD_ROLE is missing"
      );
    }

    if (!appid) {
      throw new Error(
        "ADMCLOUD_APP_ID is missing"
      );
    }

    config.headers.Authorization =
      getAdmCloudAuthHeader();

    config.params = {
      ...(config.params || {}),
      company,
      role,
      appid,
    };

    return config;
  }
);

admcloudClient.interceptors.response.use(
  (response) => response,

  (error) => {
    const status =
      error.response?.status;

    const data =
      error.response?.data;

    console.error(
      "🔴 ADM CLOUD ERROR:",
      {
        status,
        method:
          error.config?.method,
        url:
          error.config?.url,
        data,
      }
    );

    throw {
      status:
        status || 500,

      message:
        data?.message ||
        error.message ||
        "Adm Cloud request failed",

      data:
        data || null,
    };
  }
);

export default admcloudClient;