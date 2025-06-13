import BaseModel from "#models/base";
import { DataTypes } from "sequelize";

class Asset extends BaseModel {
  static INDEX_CONFIGS = {
    NIFTY: {
      displayName: "NIFTY50",
      csvName: "NIFTY",
      csvExchange: "NFO",
      csvSymbolPrefix: "NIFTY",
      excludeSymbolPrefixes: ["NIFTYNXT", "NIFTYMID", "NIFTYFIN", "NIFTYBANK"],
    },
    SENSEX: {
      displayName: "SENSEX",
      csvName: "SENSEX",
      csvExchange: "BFO",
      csvSymbolPrefix: "SENSEX",
      excludeSymbolPrefixes: [],
    },
  };
}

Asset.initialize({
  name: {
    type: DataTypes.ENUM(Object.keys(Asset.INDEX_CONFIGS)),
    allowNull: false,
    //WARN: Unique constraint missing
  },
  zerodhaToken: {
    type: DataTypes.INTEGER,
  },
  upstoxToken: {
    type: DataTypes.STRING,
  },
});

export default Asset;
