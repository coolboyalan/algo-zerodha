import User from "#models/user";
import Asset from "#models/asset";
import Broker from "#models/broker";
import BaseModel from "#models/base";
import { DataTypes } from "sequelize";
import BrokerKey from "#models/brokerKey";

class Trade extends BaseModel {}

Trade.initialize({
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
  price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  parentTrade: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  profitAndLoss: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
  },
  tradeTime: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  direction: {
    type: DataTypes.ENUM("buy", "sell"),
    allowNull: false,
  },
  type: {
    type: DataTypes.ENUM("entry", "exit"),
    allowNull: false,
  },
});

Trade.belongsTo(User, {
  foreignKey: "userId",
});

Trade.belongsTo(Broker, {
  foreignKey: "brokerId",
});

export default Trade;
