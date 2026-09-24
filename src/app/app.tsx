// Barrel: the feature UIs live in ./(app)/ui/*. Route pages still import from
// "../../app", so this re-export keeps every page working after the split.

export { Dashboard } from "./(app)/ui/dashboard";
export { Stock, RunMode } from "./(app)/ui/stock";
export { Delivery } from "./(app)/ui/delivery";
export { Activity } from "./(app)/ui/activity";
export { Manage } from "./(app)/ui/manage";
