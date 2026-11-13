// Meals given to a worker on an attendance row (alias `a`): the lunch/dinner chosen on the daily
// register, or - when nothing was chosen - the meal entitlement of the worker's assignment.
// Absent workers get no meal.
const MEAL_TYPES = ['lunch', 'dinner'];

const MEAL_SQL = (meal) => {
  if (!MEAL_TYPES.includes(meal)) throw new Error(`Unknown meal ${meal}`);
  return `IF(a.status = 'present', COALESCE(a.${meal},
    EXISTS(SELECT 1 FROM meal_entitlements me WHERE me.assignment_id = a.assignment_id AND me.meal_type = '${meal}')), 0)`;
};

module.exports = { MEAL_TYPES, MEAL_SQL };
