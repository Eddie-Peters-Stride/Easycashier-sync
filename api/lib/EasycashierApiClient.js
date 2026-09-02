import axios from "axios";

export class EasycashierClient {
    constructor({
        host = `${process.env.EASYCASHIER_API_BASE_URL}/${process.env.EASYCASHIER_COMPANY_ID}`,
        timeoutMs = 20_000,
    } = {}) {
        if (!process.env.EASYCASHIER_API_BASE_URL || !process.env.EASYCASHIER_API_TOKEN || !process.env.EASYCASHIER_COMPANY_ID) {
            throw new Error("Missing EASYCASHIER_API_BASE_URL or EASYCASHIER_API_TOKEN or EASYCASHIER_API_COMPANY_ID environment variable");
        }

        this.api = axios.create({
            baseURL: `${host}`,
            timeout: timeoutMs,
            headers: {
                "Content-Type": "application/json",
                [process.env.EASYCASHIER_API_AUTH_HEADER_NAME || "X-Api-Key"]:
                    process.env.EASYCASHIER_API_TOKEN,
            },
        });
    }

    /**
      * Get products from EasyCashier
      * @param {Object} input - Product input data
      * @returns {Promise<Object>} Synced product data
      */
    async getProducts() {
        const res = await this.api.get(`/article`);
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
        if (!input?.id) {
            throw new Error("Missing product id for deletion");
        }

        const res = await this.api.delete(`/article/${input.id}`, {
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
    async updateProduct({ input }) {
        if (!input?.id) {
            throw new Error("Missing product id for update");
        }
        const res = await this.api.put(`/article/${input.id}`, input);
        const response = res.data;
        return response;
    }


    /**
        * Get sales data from Easycashier
        * @param {Object} input - Product input data
        * @returns {Promise<Object>} Synced product data
        */
    async getSalesData({ input }) {
        const res = await this.api.get(`/company/${input.companyId}/report/sales/groupedByArticle/preview`, { params: input });
        const response = res.data;
        return response;
    }
}
