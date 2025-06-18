import User from "#models/user";
import Asset from "#models/asset";
import Broker from "#models/broker";
import BaseModel from "#models/base";
import { DataTypes } from "sequelize";
import BrokerKey from "#models/brokerKey";

class TradeLog extends BaseModel {}

TradeLog.initialize({
  brokerId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: Broker,
      key: Broker.primaryKeyAttribute,
    },
  },
  brokerKeyId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: BrokerKey,
      key: BrokerKey.primaryKeyAttribute,
    },
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: User,
      key: User.primaryKeyAttribute,
    },
  },
  baseAssetId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: Asset,
      key: Asset.primaryKeyAttribute,
    },
  },
  asset: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  direction: {
    type: DataTypes.ENUM("buy", "sell"),
    allowNull: false,
  },
  quantity: {
    type: DataTypes.INTEGER,
  },
  type: {
    type: DataTypes.ENUM("entry", "exit"),
    allowNull: false,
  },
});

TradeLog.belongsTo(User, {
  foreignKey: "userId",
});

TradeLog.belongsTo(Broker, {
  foreignKey: "brokerId",
});

export default TradeLog;
