import User from "#models/user";
import Broker from "#models/broker";
import BaseModel from "#models/base";
import { DataTypes } from "sequelize";

class BrokerKey extends BaseModel {}

BrokerKey.initialize(
  {
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: User,
        key: User.primaryKeyAttribute,
      },
    },
    brokerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: Broker,
        key: Broker.primaryKeyAttribute,
      },
    },
    apiKey: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    apiSecret: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    token: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    tokenDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    balance: {
      type: DataTypes.STRING,
    },
    loginUrl: {
      type: DataTypes.TEXT,
    },
    redirectUrl: {
      type: DataTypes.TEXT,
    },
  },
  {
    indexes: [
      {
        unique: true,
        fields: ["userId", "brokerId"],
      },
    ],
  },
);

BrokerKey.belongsTo(Broker, {
  foreignKey: "brokerId",
});

BrokerKey.belongsTo(User, {
  foreignKey: "userId",
});

export default BrokerKey;
