import { Model } from "sequelize";
import httpStatus from "http-status";
import sequelize from "#configs/database";
import AppError from "#utils/appError";

class BaseModel extends Model {
  static excludedBranchModels = ["Branch", "City", "State", "Country", "Auth"];

  /**
   * Initialize the model with the given model definition and options.
   * @param {object} modelDefinition - The model definition
   * @param {object} options - The options for the model
   */
  static initialize(modelDefinition, options) {
    const modifiedModelDefinition = this.modifyModelDefinition(modelDefinition);

    this.init(
      {
        ...modifiedModelDefinition,
        //createdBy: {
        //  type: DataTypes.INTEGER,
        //  allowNull: true,
        //  filterable: true,
        //},
        //updatedBy: {
        //  type: DataTypes.INTEGER,
        //  allowNull: true,
        //  filterable: true,
        //},
      },
      {
        hooks: {},
        ...options,
        sequelize,
        timestamps: true,
        paranoid: true,
      },
    );
  }

  static updatedName() {
    return this.name;
  }

  static modifyModelDefinition(modelDefinition) {
    return Object.entries(modelDefinition).reduce((acc, [key, value]) => {
      acc[key] = {
        ...value,
        filterable: value.filterable ?? true,
        searchable: value.searchable ?? true,
        ...(modelDefinition[key]["references"]
          ? {
              references: modelDefinition[key]["references"],
              validate: { isInt: { msg: `Invalid ${key}` } },
            }
          : {}),
      };
      return acc;
    }, {});
  }

  static async findDocById(id, options = {}) {
    this.idChecker(id);

    return await this.findDoc({ id }, options);
  }

  static async findDoc(filters, options = {}) {
    const { allowNull = false } = options;

    delete options.allowNull;

    const doc = await this.findOne({
      where: filters,
      ...options,
    });

    if (doc || allowNull) {
      return doc;
    }
    throw new AppError({
      status: false,
      message: `${this.updatedName()} not found`,
      httpStatus: httpStatus.NOT_FOUND,
    });
  }

  static async create(data, options = {}) {
    const createdDocument = await super.create(data);
    return createdDocument;
  }

  static getSearchableFields(allowedFields) {
    return Object.keys(allowedFields).filter(
      (field) => allowedFields[field].searchable,
    );
  }

  static getFilterableFields(allowedFields) {
    return Object.keys(allowedFields).filter(
      (field) => allowedFields[field].filterable,
    );
  }

  static rawFields() {
    return this.getAttributes();
  }

  /**
   * Update a record by its ID.
   * @param {any} id - The ID of the record to update
   * @param {Object} updates - The updates to apply to the record
   * @return {Promise<Object>} The updated record
   */
  static async updateById(id, updates) {
    this.idChecker(id);
    const [updatedCount, updatedRecord] = await this.update(updates, {
      where: { id },
    });

    const doc = await this.findByPk(id);

    if (updatedCount !== 1) {
      throw new AppError({
        status: false,
        httpStatus: httpStatus.NOT_FOUND,
        message: `${this.name} not found`,
      });
    }
    return updatedRecord;
  }

  updateFields(updates) {
    for (let i in updates) {
      this[i] = updates[i];
    }
  }

  /**
   * Delete a record by its ID.
   *
   * @param {any} id - The ID of the record to delete
   * @return {Promise<Object>} The updated record
   */
  static async deleteById(id) {
    this.idChecker(id);
    const time = new Date();
    const [updatedCount, updatedRecord] = await this.update(
      { deletedAt: time },
      {
        where: { id, deletedAt: null },
        individualHooks: true,
      },
    );
    if (updatedCount !== 1 || !updatedRecord || !updatedRecord.length) {
      throw new AppError({
        status: false,
        httpStatus: httpStatus.NOT_FOUND,
        message: `${this.name} not found`,
      });
    }
    return updatedRecord;
  }

  static idChecker(id) {
    if (!id || isNaN(id)) {
      throw new AppError({
        status: false,
        httpStatus: httpStatus.NOT_FOUND,
        message: `Invalid or missing ${this.name} id`,
      });
    }
  }

  static objectValidator(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export default BaseModel;
