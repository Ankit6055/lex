let nextId = 1;

export function createUser({ name, email, age }) {
  return { id: nextId++, name, email, age, createdAt: new Date().toISOString() };
}
