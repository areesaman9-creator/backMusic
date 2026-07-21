import mongoose, { Document, Schema } from "mongoose";
import bcrypt from "bcryptjs";

export interface IUser extends Document {
  telegramId: string;
  telegramUsername?: string;
  name: string;
  email?: string;
  password?: string;
  isActive: boolean;
  lastLogin: Date | null;
  refreshToken?: string;
  subscriptionPlan: string | null;
  subscriptionExpiresAt: Date | null;
  reservedDaysAfterPromo: { type: Number, default: null },
  role: string;
  comparePassword(candidatePassword: string): Promise<boolean>;
  toPublicJSON(): object;
}

const userSchema = new Schema<IUser>(
  {
    telegramId: {
      type: String,
      unique: true,
      sparse: true,
    },
    telegramUsername: { type: String, default: null },
    name: { type: String, trim: true, default: "" },
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      minlength: 6,
      select: false,
    },
    role: { type: String, default: "user" },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date, default: null },
    refreshToken: { type: String, select: false },
    subscriptionPlan: { type: String, default: null },
    subscriptionExpiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = async function (
  candidatePassword: string,
): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.toPublicJSON = function () {
  return {
    id: this._id,
    telegramId: this.telegramId,
    telegramUsername: this.telegramUsername,
    name: this.name,
    email: this.email,
    isActive: this.isActive,
    role: this.role,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    lastLogin: this.lastLogin,
    subscriptionPlan: this.subscriptionPlan,
    subscriptionExpiresAt: this.subscriptionExpiresAt,
  };
};

userSchema.index({ telegramId: 1 });
userSchema.index({ email: 1 });

export default mongoose.model<IUser>("User", userSchema);
