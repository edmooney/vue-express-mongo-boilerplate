"use strict";

let logger 		= require("../../../core/logger");
let config 		= require("../../../config");
let C 	 		= require("../../../core/constants");
let E 			= require("../../../core/errors");
let path 		= require("path");
let async 		= require("async");
let crypto 		= require("crypto");
let mailer 		= require("../../../libs/mailer");

let _			= require("lodash");

let User 		= require("./models/user");
let pug 		= require("pug");

module.exports = {
	name: "users",
	//version: 1,

	settings: {
		//latestVersion: true,
		rest: true,
		ws: true,
		graphql: true,
		permission: C.PERM_ADMIN, // as specified in https://github.com/icebob/vue-express-mongo-boilerplate/issues/48
		collection: User,
		
		hashedIdentity: true,
		// modelPropFilter: "code fullName email username password passwordLess passwordLessToken provider profile socialLinks roles resetPasswordToken resetPasswordExpires verified verifyToken apiKey lastLogin locale status createdAt updatedAt"
		modelPropFilter: "code fullName email username provider profile socialLinks roles verified apiKey lastLogin locale status createdAt updatedAt"
	},
	
	actions: {
		list: {
			cache: {
				keys: [ "limit", "offset", "sort", "filter", "author" ]
			},
			defaultMethod: "get",
			handler(ctx) {
				let filter = {};

				let query = this.collection.find(filter);
				return this.applyFilters(query, ctx).exec()
				.then(docs => this.toJSON(docs))
				.then(json => this.populateModels(ctx, json));
			}
		},

		// return a user by ID
		get: {
			cache: {
				keys: [ "code" ]
			},
			defaultMethod: "get",
			needModel: true,
			handler(ctx) {
				return this.Promise.resolve(ctx)
				.then(ctx => ctx.call(this.name + ".model", { code: ctx.params.code }))
				.then(model => this.checkModel(model, "app:UserNotFound"))
				.then(doc => this.toJSON(doc))
				.then(json => this.populateModels(ctx, json));
			}
		},
		// // SWYX: may want to return user by username or email too but these are not guaranteed unique
		model: {
			cache: true,
			publish: false,
			handler(ctx) {
				return this.resolveModel(ctx);
			}
		},

		create: {
			defaultMethod: "post",
			handler(ctx) {
				let resetToken;
				return this.Promise.resolve(ctx)
				.then(() => {
					resetToken = crypto.randomBytes(25).toString("hex");
					let resetTokenExpiry = Date.now() + 24 * 3600000; // expire in 24 hours
					let user = new User({
						fullName: ctx.params.fullName,
						email: ctx.params.email,
						username: ctx.params.username,
						password: crypto.randomBytes(25).toString("hex"), // need an acceptable password to pass validation
						provider: ctx.params.provider,
						profile: ctx.params.profile,
						socialLinks: ctx.params.socialLinks,
						roles: ctx.params.roles,
						resetPasswordToken: resetToken, // specially generated by us
						resetPasswordExpires: resetTokenExpiry, // specially generated by us
						verified: ctx.params.verified,
						verifyToken: ctx.params.verifyToken,
						apiKey: ctx.params.apiKey,
						lastLogin: ctx.params.lastLogin,
						locale: ctx.params.locale,
						status: ctx.params.status,
					});
					user.passwordLess = true; // No password for this account. He/she can login via social login or passwordless login
					user.verified = true; // No need to verify a social signup
					return user.save().catch(err => {
						if (err && err.code === 11000) {
							let field = err.message.split("index: ")[1];
							field = field.split(" dup key")[0];
							field = field.substring(0, field.lastIndexOf("_"));
							let newErr = new Error("Unable to create user!");
							newErr.params = {
								field: field,
								toastmessage: "Unable to create user, duplicate field: " + field,
							};
							newErr.msgCode = "DuplicateFieldError: " + field;
							newErr.message = "Unable to create user, duplicate field: " + field;
							newErr.type = "BAD_REQUEST";
							newErr.status = 400;
							throw newErr;
						}
						throw err;
					});
				})
				.then(doc => this.toJSON(doc))
				.then(json => this.populateModels(ctx, json))
				.then(json => {
					this.notifyModelChanges(ctx, "created", json, ctx.params.$user);

					// Clear cached values
					this.clearCache();

					return json;
				})
				.then(json => {
					// 	let subject = req.t("mailSubjectResetPassword", config);
					let subject = "mailSubjectResetPassword";
					pug.renderFile(path.join(__dirname, "../../../views/mail/passwordReset.pug"), {
						name: ctx.params.fullName,
						resetLink: config.app.url + "reset/" + resetToken,
						app: config.app
					}, function(err, html) {
						if (err) 
							return Promise.reject(new Error("Unable to render e-mail! " + err.message));

						mailer.send(ctx.params.email, subject, html, function(err, info) {
							if (err)
								this.notifyModelChanges(ctx, "error", "UnableToSendEmail", ctx.params.$user);
								// req.flash("error", { msg: req.t("UnableToSendEmail", user) });
							else
								this.notifyModelChanges(ctx, "info", "emailSentPasswordResetLink", ctx.params.$user);
								// req.flash("info", { msg: req.t("emailSentPasswordResetLink", user) });
							// done(err);
						});
					});
					return json;
				});	
			}
		},

		update: {
			defaultMethod: "put",
			needModel: true,
			handler(ctx) {
				return this.Promise.resolve(ctx)
				.then(ctx => this.resolveID(ctx))
				.then(modelID => this.checkModel(modelID, "app:UserNotFound"))
				// .then(ctx => this.checkDuplicateField(ctx,"username"))
				.then(modelID => this.collection.findById(modelID).exec())
				.then(doc => {

					if (ctx.params.fullName != null) doc.fullName = ctx.params.fullName;
					if (ctx.params.email != null) doc.email = ctx.params.email;
					if (ctx.params.username != null) doc.username = ctx.params.username;
					if (ctx.params.password != null) doc.password = ctx.params.password;
					if (ctx.params.passwordLess != null) doc.passwordLess = ctx.params.passwordLess;
					if (ctx.params.passwordLessToken != null) doc.passwordLessToken = ctx.params.passwordLessToken;
					if (ctx.params.provider != null) doc.provider = ctx.params.provider;
					if (ctx.params.profile != null) doc.profile = ctx.params.profile;
					if (ctx.params.socialLinks != null) doc.socialLinks = ctx.params.socialLinks;
					if (ctx.params.roles != null) doc.roles = ctx.params.roles;
					if (ctx.params.resetPasswordToken != null) doc.resetPasswordToken = ctx.params.resetPasswordToken;
					if (ctx.params.resetPasswordExpires != null) doc.resetPasswordExpires = ctx.params.resetPasswordExpires;
					if (ctx.params.verified != null) doc.verified = ctx.params.verified;
					if (ctx.params.verifyToken != null) doc.verifyToken = ctx.params.verifyToken;
					if (ctx.params.apiKey != null) doc.apiKey = ctx.params.apiKey;
					if (ctx.params.lastLogin != null) doc.lastLogin = ctx.params.lastLogin;
					if (ctx.params.locale != null) doc.locale = ctx.params.locale;
					if (ctx.params.status != null) doc.status = ctx.params.status;

					return doc.save().catch(err => {
						if (err && err.code === 11000) {
							let field = err.message.split("index: ")[1];
							field = field.split(" dup key")[0];
							field = field.substring(0, field.lastIndexOf("_"));
							let newErr = new Error("Unable to update user!");
							newErr.params = {
								field: "DuplicateFieldError: " + field,
								toastmessage: "Unable to create user, duplicate field: " + field,
							};
							newErr.msgCode = "DuplicateFieldError: " + field;
							newErr.message = "Unable to update user, duplicate field " + field;
							newErr.type = "BAD_REQUEST";
							newErr.status = 400;
							throw newErr;
						}
						throw err;
					});
				})
				.then(doc => this.toJSON(doc))
				.then(json => this.populateModels(ctx, json))
				.then((json) => {
					this.notifyModelChanges(ctx, "updated", json, ctx.params.$user);
					
					// Clear cached values
					this.clearCache();

					return json;
				});	
			}							
		},

		remove: {
			defaultMethod: "delete",
			needModel: true,
			handler(ctx) {
				console.log('remote', ctx);
				return this.Promise.resolve(ctx)
				.then(ctx => ctx.call(this.name + ".model", { code: ctx.params.code }))
				.then(model => this.checkModel(model, "app:UserNotFound"))
				.then(model => {
					return this.collection.remove({ _id: model.id }).then(() => model);
				})
				.then(doc => this.toJSON(doc))
				.then(json => this.populateModels(ctx, json))
				.then((json) => {
					this.notifyModelChanges(ctx, "removed", json, ctx.params.$user);
					
					// Clear cached values
					this.clearCache();

					return json;
				});		
			}
		}

	},

	// Event listeners
	events: {

	},

	// Service methods
	methods: {

	},

	created() {
		// this.logger.info("Service created!");
	},

	started() {
		// this.logger.info("Service started!");
	},

	stopped() {
		// this.logger.info("Service stopped!");
	},

	graphql: {

		query: `
			users(limit: Int, offset: Int, sort: String): [User]
			user(code: String): User
		`,

		// SWYX: not sure about the [String] as these are technically objects
		types: `
			type User {
				fullName: String
				email: String
				username: String
				password: String
				passwordLess: Boolean
				passwordLessToken: String
				provider: String
				profile: SocialProfile
				socialLinks: SocialLinks
				roles: [String]
				resetPasswordToken: String
				resetPasswordExpires: Timestamp
				verified: Boolean
				verifyToken: String
				apiKey: String
				lastLogin: Timestamp
				locale: String
				status: Int
			}

			type SocialProfile {
				name: String
				gender: String
				picture: String
				location: String
			}

			type SocialLinks {
				facebook: String
				twitter: String
				google: String
				github: String
			}

		`,

		// SWYX: intentionally left out profile, socialLinks, roles, resetPasswordExpires, resetPasswordToken
		mutation: `
			userCreate(fullName: String, email: String, username: String, password: String, passwordLess: Boolean, passwordLessToken: String, provider: String, verified: Boolean, verifyToken: String, apiKey: String, lastLogin: Timestamp, local: String, status: Int): User
			userUpdate(code: String!, fullName: String, email: String, username: String, password: String, passwordLess: Boolean, passwordLessToken: String, provider: String, verified: Boolean, verifyToken: String, apiKey: String, lastLogin: Timestamp, local: String, status: Int): User
			userRemove(code: String!): User
		`,

		resolvers: {
			Query: {
				users: "list",
				user: "get"
			},

			Mutation: {
				userCreate: "create",
				userUpdate: "update",
				userRemove: "remove"
			}
		}
	}

};

/*
## GraphiQL test ##

# Find all devices
query getDevices {
  devices(sort: "lastCommunication", limit: 5) {
    ...deviceFields
  }
}

# Create a new device
mutation createDevice {
  deviceCreate(name: "New device", address: "192.168.0.1", type: "raspberry", description: "My device", status: 1) {
    ...deviceFields
  }
}

# Get a device
query getDevice($code: String!) {
  device(code: $code) {
    ...deviceFields
  }
}

# Update an existing device
mutation updateDevice($code: String!) {
  deviceUpdate(code: $code, address: "127.0.0.1") {
    ...deviceFields
  }
}

# Remove a device
mutation removeDevice($code: String!) {
  deviceRemove(code: $code) {
    ...deviceFields
  }
}

fragment deviceFields on Device {
    code
    address
    type
    name
    description
    status
    lastCommunication
}

*/