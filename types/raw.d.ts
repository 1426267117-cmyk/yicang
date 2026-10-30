declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}

declare module '*.graphql?raw' {
  const graphql: string;
  export default graphql;
}
