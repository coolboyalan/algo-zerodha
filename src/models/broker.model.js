import BaseModel from "#models/base";
import { DataTypes } from "sequelize";

class Broker extends BaseModel {}

Broker.initialize({
  name: {
    type: DataTypes.ENUM("Zerodha", "Upstox", "Angel One"),
    allowNull: false,
    unqiue: true,
  },
});

export default Broker;
