import env from "#configs/env";
import { Sequelize } from "sequelize";

const sequelize = new Sequelize(env.DB_NAME, env.DB_USER, env.DB_PASS, {
  host: env.DB_HOST,
  port: env.DB_PORT,
  dialect: env.DB_DIALECT,
  logging: false,
  pool: {
    max: 20, // increase this based on your DB's max_connections
    min: 2,
    acquire: 30000, // how long Sequelize will try to get a connection (ms)
    idle: 10000, // how long a connection can stay idle before being released
  },
});

export default sequelize;
