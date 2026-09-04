import axios from "axios";
import { mockTodaysSalesData } from "./mockEasycashierSales.js";

const DEFAULT_LOGIN_URL = "https://backoffice.easycashier.se/v1/login";
const DEFAULT_TOKEN_REFRESH_BUFFER_MS = 60_000;

export class EasycashierClient {
    constructor({
        host,
        loginUrl = process.env.EASYCASHIER_LOGIN_URL || DEFAULT_LOGIN_URL,
        username = process.env.EASYCASHIER_API_USERNAME,
        password = process.env.EASYCASHIER_API_PASSWORD,
        authHeaderName = process.env.EASYCASHIER_API_AUTH_HEADER_NAME || "x-auth-token",
        timeoutMs = 20_000,
        tokenRefreshBufferMs = DEFAULT_TOKEN_REFRESH_BUFFER_MS,
    } = {}) {
        const apiBaseUrl = process.env.EASYCASHIER_API_BASE_URL;
        const companyId = process.env.EASYCASHIER_COMPANY_ID;

        if (!host && (!apiBaseUrl || !companyId)) {
            throw new Error(
                "Missing EASYCASHIER_API_BASE_URL or EASYCASHIER_COMPANY_ID environment variable"
            );
        }

        if (!username || password == null) {
            throw new Error(
                "Missing EASYCASHIER_API_USERNAME or EASYCASHIER_API_PASSWORD environment variable"
            );
        }

        this.loginUrl = loginUrl;
        this.username = username;
        this.password = password;
        this.authHeaderName = authHeaderName;
        this.tokenRefreshBufferMs = Math.max(0, Number(tokenRefreshBufferMs) || 0);
        this.accessToken = null;
        this.accessTokenValidUntil = 0;
        this.loginPromise = null;

        this.loginApi = axios.create({
            timeout: timeoutMs,
            headers: {
                "Content-Type": "application/json",
            },
        });

        this.api = axios.create({
            baseURL: host || `${apiBaseUrl.replace(/\/$/, "")}/${companyId}`,
            timeout: timeoutMs,
            headers: {
                "Content-Type": "application/json",
            },
        });

        this.api.interceptors.request.use(async (config) => {
            const accessToken = await this.getValidAccessToken();
            config.headers.set(this.authHeaderName, accessToken);
            return config;
        });

        this.api.interceptors.response.use(
            (response) => response,
            async (error) => {
                const request = error?.config;

                if (error?.response?.status !== 401 || !request || request._easycashierAuthRetried) {
                    throw error;
                }

                request._easycashierAuthRetried = true;
                const rejectedAccessToken = request.headers.get(this.authHeaderName);
                const accessToken = await this.getValidAccessToken({
                    forceRefresh: rejectedAccessToken === this.accessToken,
                });
                request.headers.set(this.authHeaderName, accessToken);

                return await this.api.request(request);
            }
        );
    }

    /**
     * Log in to EasyCashier and store the returned access token.
     * Credentials are read from private Gadget environment variables by default.
     * @returns {Promise<string>} The new access token
     */
    async login() {
        let response;

        try {
            response = await this.loginApi.post(this.loginUrl, {
                username: this.username,
                password: this.password,
            });
        } catch (error) {
            const status = error?.response?.status;
            throw new Error(
                `EasyCashier login failed${status ? ` with status ${status}` : ""}`
            );
        }

        const authentication = response?.data;
        const expiresInSeconds = Number(authentication?.expiresIn);

        if (
            authentication?.authenticationResponseType !== "AUTHORIZATION_SUCCESSFUL" ||
            typeof authentication?.accessToken !== "string" ||
            !authentication.accessToken ||
            !Number.isFinite(expiresInSeconds) ||
            expiresInSeconds <= 0
        ) {
            throw new Error("EasyCashier login returned an invalid authentication response");
        }

        const now = Date.now();
        const expiresInMs = expiresInSeconds * 1_000;
        const refreshBufferMs = Math.min(this.tokenRefreshBufferMs, expiresInMs * 0.1);

        this.accessToken = authentication.accessToken;
        this.accessTokenValidUntil = now + expiresInMs - refreshBufferMs;

        return this.accessToken;
    }

    /**
     * Return a valid token, logging in again when it is missing or near expiry.
     * A shared promise prevents concurrent API calls from performing duplicate logins.
     */
    async getValidAccessToken({ forceRefresh = false } = {}) {
        const tokenIsValid = this.accessToken && Date.now() < this.accessTokenValidUntil;

        if (!forceRefresh && tokenIsValid) {
            return this.accessToken;
        }

        if (!this.loginPromise) {
            this.loginPromise = this.login().finally(() => {
                this.loginPromise = null;
            });
        }

        return await this.loginPromise;
    }

    /**
      * Get products from EasyCashier
      * @param {Object} input - Product input data
      * @returns {Promise<Object>} Synced product data
      */
    async getProducts({ searchValue } = {}) {
        const normalizedSearchValue = searchValue == null ? "" : String(searchValue).trim();
        const res = await this.api.get(`/article`, {
            params: {
                itemsPerPage: 50,
                pageNumber: 1,
                sortColumn: "articleNumber",
                sortDirection: "asc",
                ...(normalizedSearchValue ? { searchValue: normalizedSearchValue } : {}),
            },
        });
        const response = res.data;
        return response;
    }


    /**
      * Create product in EasyCashier
      * @param {Object} input - Product input data
      * @returns {Promise<Object>} Synced product data
      */
    async createProduct({ input }) {
        const res = await this.api.post(`/article`, input);
        const response = res.data;
        return response;
    }


    /**
     * Delete product from EasyCashier
     * @param {Object} input - Product input data
     * @returns {Promise<Object>} Synced product data
     */
    async deleteProduct({ input }) {
        if (!input?.articleNumber) {
            throw new Error("Missing article number for deletion");
        }

        const res = await this.api.delete(`/article/${encodeURIComponent(input.articleNumber)}`, {
            data: input,
        });

        const response = res.data;
        return response;
    }


    /**
     * Update product in EasyCashier
     * @param {Object} input - Product input data
     * @returns {Promise<Object>} Synced product data
     */
    async updateProduct({ id, input }) {
        if (!id) {
            throw new Error("Missing product id for update");
        }
        const res = await this.api.put(`/article/${encodeURIComponent(id)}`, input);
        const response = res.data;
        return response;
    }


    /**
     * Get all sales rows for today's date in Sweden.
     * @returns {Promise<{date: string, items: Object[]}>} Today's sales grouped by article and store
     */
    async getTodaysSalesData({ test = false } = {}) {
        const today = new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Europe/Stockholm",
        }).format(new Date());

        if (test) {
            return { date: today, ...mockTodaysSalesData };
        }

        const items = [];
        const itemsPerPage = 50;

        for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
            const response = await this.api.get(
                "/report/sales/groupedByArticleAndStore/preview",
                {
                    params: {
                        itemsPerPage,
                        pageNumber,
                        startDate: today,
                        stopDate: today,
                    },
                }
            );
            const pageItems = response.data?.items;

            if (!Array.isArray(pageItems)) {
                throw new Error("EasyCashier sales response did not contain an items array");
            }

            items.push(...pageItems);

            if (pageItems.length < itemsPerPage) {
                return { date: today, items };
            }
        }

        throw new Error("EasyCashier sales report exceeded 100 pages");
    }
}
