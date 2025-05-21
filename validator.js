// validator.js - Utilities for data validation
export const validator = {
    /**
     * Checks if a string is not empty and does not contain only whitespace.
     * @param {string} str - The string to validate.
     * @returns {boolean} True if the string is valid, otherwise false.
     */
    isNonEmptyString(str) {
        return typeof str === 'string' && str.trim().length > 0;
    },

    /**
     * Checks if a string is a valid alphanumeric slug.
     * @param {string} slug - The slug to validate.
     * @returns {boolean} True if the slug is valid, otherwise false.
     */
    isValidSlug(slug) {
        return typeof slug === 'string' && /^[a-zA-Z0-9]+$/.test(slug);
    },

    /**
     * Checks if an object has all specified properties.
     * @param {object} obj - The object to validate.
     * @param {string[]} properties - An array of property names that must exist in the object.
     * @returns {boolean} True if the object contains all properties, otherwise false.
     */
    hasAllProperties(obj, properties) {
        if (typeof obj !== 'object' || obj === null) {
            return false;
        }
        for (const prop of properties) {
            if (!obj.hasOwnProperty(prop)) {
                return false;
            }
        }
        return true;
    }
};