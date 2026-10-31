// fourth_power normalized object model (spec §11) — JSDoc typedefs only.
// This file has no runtime state; it exists so that gate/budget/loop/claims can
// express types and so that Main's integration owns the canonical typedefs.

/**
 * @typedef {object} Issue
 * @property {string} id
 * @property {number} number
 * @property {string} repo
 * @property {string} title
 * @property {string} body
 * @property {string} author
 * @property {string[]} labels
 * @property {'open'|'closed'} state
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} ChangeRequest (PR)
 * @property {string} id
 * @property {number} number
 * @property {string} repo
 * @property {string} base
 * @property {string} headSha
 * @property {string} author
 * @property {boolean} draft
 * @property {string[]} labels
 * @property {null|boolean} mergeable
 * @property {'open'|'closed'|'merged'} state
 * @property {string} body
 */

/**
 * @typedef {object} Note
 * @property {string} id
 * @property {string} author
 * @property {string} body
 * @property {string} createdAt
 * @property {number|null} prNumber
 * @property {number|null} issueNumber
 * @property {null|boolean} resolved
 */

/**
 * @typedef {object} Check
 * @property {string} name
 * @property {'pending'|'success'|'failure'} state
 * @property {string} headSha
 * @property {string} issuer
 */

/**
 * @typedef {object} Approval
 * @property {string} reviewer
 * @property {string} sha
 */

/**
 * @typedef {object} ReviewThread
 * @property {string} id
 * @property {boolean} resolved
 */

/**
 * @typedef {object} Protection
 * @property {string[]} requiredChecks
 * @property {number} requiredApprovals
 * @property {boolean} dismissStaleReviews
 * @property {boolean} enforceAdmins
 */

export {};
