//
//  © Copyright IBM Corporation 2017
//  LICENSE: MIT http://ibm.biz/license-non-ios
//

var appVars = require('../config/appVars');

/**
 * Controller for creating and editing user accounts
 * @type {{}}
 */
var userController = {};

/**
 * Registers a new user by saving them in the db.
 * @param user
 */
userController.registerUser = function(user) {
    return userController.saveUser(user);
};

/**
 * Save the given user to the db.
 * @param user
 * @returns {Promise}
 */
userController.saveUser = function (user) {
    return new Promise(function (resolve, reject) {
        var pool = appVars.pool;
        pool.connect(function (err, client, done) {
            if (err) {
                return console.error('error fetching client from pool', err);
            }
            // Update users if exists, otherwise insert it
            // Warning: this is not safe if executed from multiple sessions at the same time
            client.query("UPDATE users SET id=$1, device_token=$2 WHERE id=$1;", [user.id, user.deviceToken]);
            client.query("INSERT INTO users (id) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = $2);", [user.id, user.id],
                function (err) {
                    done(err);
                    if (err) reject(err);

                    resolve(user);
                }
            );
        });
    });
};

/**
 * Saves the external account to the user with the given id to the db.
 * @param userId
 * @param externalAccount
 * @returns {Promise}
 */
userController.saveExternalAccount = function(userId, externalAccount) {
    return new Promise(function (resolve, reject) {
        var parameters = [externalAccount.id, externalAccount.accessToken.cipher, externalAccount.accessToken.iv, externalAccount.accessToken.tag,
            externalAccount.refreshToken.cipher, externalAccount.refreshToken.iv, externalAccount.refreshToken.tag, userId, externalAccount.provider];
        var pool = appVars.pool;
        pool.connect(function (err, client, done) {
            if (err) {
                return console.error('error fetching client from pool', err);
            }
            // Update external account if exists with that provider, otherwise insert it
            // Warning: this is not safe if executed from multiple sessions at the same time
            client.query("UPDATE external_auth SET id=$1, access_token=$2, at_iv=$3, at_tag=$4, refresh_token=$5, rt_iv=$6, rt_tag=$7 WHERE user_id=$8 AND provider=$9;", parameters);
            client.query("INSERT INTO external_auth (id, access_token, at_iv, at_tag, refresh_token, rt_iv, rt_tag, user_id, provider) SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9"
                + "WHERE NOT EXISTS (SELECT 1 FROM external_auth WHERE user_id=$8 AND provider=$9);", parameters,
                function (err) {
                    done(err);
                    if (err) reject(err);

                    resolve();
                }
            );
        });
    });
};

/**
 * Retrieve the user info and external accounts for the user with the given id.
 * @param id
 * @returns {Promise}
 */
userController.getUserByID = function (id) {
    return new Promise(function (resolve, reject) {
        var pool = appVars.pool;
        pool.connect(function (err, client, done) {
            if (err) {
                return console.error('error fetching client from pool', err);
            }
            // Get user info
            client.query("SELECT id, device_token FROM users WHERE id=$1", [id],
                function (err, result) {
                    if (err) {
                        done(err);
                        reject(err);
                    }
                    else if (result.rowCount < 1) {
                        done(err);
                        resolve(null);
                    }
                    else {
                        var user = {id: result.rows[0].id, deviceToken: result.rows[0].device_token};
                        // Get external accounts
                        client.query("SELECT id, provider, access_token, at_iv, at_tag FROM external_auth WHERE user_id=$1", [id],
                            function (err, result) {
                                done(err);
                                if (err) reject(err);
                                user.externalAccounts = result.rows;
                                resolve(user);
                            });
                    }
                }
            );
        });
    })
};

/**
 * Retrieve the user account associated with the given external account.
 * @param externalAccount
 * @returns {Promise}
 */
userController.getUserAccountByExternalAccount = function (externalAccount) {
    return new Promise(function (resolve, reject) {
        var pool = appVars.pool;
        pool.connect(function (err, client, done) {
            if (err) {
                return console.error('error fetching client from pool', err);
            }
            // Get user info
            client.query("SELECT user_id FROM external_auth WHERE id=$1 AND provider=$2", [externalAccount.id, externalAccount.provider],
                function (err, result) {
                    if (err) {
                        done(err);
                        reject(err);
                    }
                    else if (result.rowCount < 1) {
                        done(err);
                        resolve(null);
                    }
                    else {
                        client.query("SELECT id, device_token FROM users WHERE id=$1", [result.rows[0].user_id],
                            function (err, result) {
                                done(err);
                                if (err) {
                                    reject(err);
                                    return
                                }
                                if (result.rowCount < 1) {
                                    resolve(null);
                                    return
                                }
                                resolve({id: result.rows[0].id, deviceToken: result.rows[0].device_token});
                            });
                    }
                }
            );
        });
    })
};

/**
 * Process authenticating a user with an external account.
 * @param req
 * @param externalAccount
 * @returns {Promise}
 */
userController.processExternalAuthentication = function (req, externalAccount) {
    return new Promise(function (resolve, reject) {
        userController.getUserAccountByExternalAccount(externalAccount)
            .then(function (user) {
                if (user) {
                    // External account is already linked to a user account
                    if (req.user) {
                        // Already logged in
                        if (req.user.id == user.id) {
                            // External already linked to logged in user, just return that
                            resolve(req.user);
                        }
                        else {
                            // uh oh, need to merge accounts
                            mergeIds(user.id, req.user.id);
                        }
                    }
                    else {
                        // return the account that's linked
                        userController.getUserByID(user.id)
                            .then(function (user) {
                                resolve(user);
                            });
                    }
                }
                else {
                    // External account is new
                    if (req.user) {
                        // already logged in, add external account
                        userController.saveExternalAccount(req.user.id, externalAccount)
                            .then(function () {
                                req.user.externalAccounts.push(externalAccount);
                                resolve(req.user);
                            });
                    }
                    else {
                        // create new account
                        generateId().then(function (id) {
                            userController.registerUser({id: id, external_account: null})
                                .then(function (user) {
                                    userController.saveExternalAccount(id, externalAccount)
                                        .then(function () {
                                            user.externalAccounts = [externalAccount];
                                            resolve(user);
                                        })
                                })
                        });
                    }
                }
            }, function (error) {
                reject(error);
            })
    })
};

/**
 * Retrieves the stream for the authenticated user if it exists, otherwise creates the stream and returns it.
 * @param req
 * @returns {Promise}
 */
userController.getOrCreateStream = function (req) {
    var user = req.user;
    var streamPath = req.body["streamPath"];
    var streamName = req.body["streamName"];
    var streamDescription = req.body["streamDescription"];
    return new Promise(function (resolve, reject) {
        var pool = appVars.pool;
        pool.connect(function (err, client, done) {
            if (err) {
                return console.error('error fetching client from pool', err);
            }
            client.query("SELECT * FROM streams WHERE user_id=$1", [user.id],
                function (err, result) {
                    if (err) {
                        done(err);
                        reject(err);
                        return;
                    }
                    if (result.rowCount > 0) {
                        done(err);
                        resolve(result.rows[0]);
                    }
                    else {
                        client.query("INSERT INTO streams (user_id, csync_path, stream_name, description) VALUES ($1, $2, $3, $4) RETURNING id", [user.id, streamPath, streamName, streamDescription],
                            function (err, result) {
                                done(err);
                                if (err) {
                                    reject(err);
                                    return;
                                }
                                if (result.rowCount < 1) {
                                    reject(null);
                                    return;
                                }
                                resolve({
                                    id: result.rows[0].id,
                                    user_id: user.id,
                                    csync_path: streamPath,
                                    stream_name: streamName
                                });
                            });
                    }
                }
            );
        });
    })
};

/**
 * Get the access token for the given user from the given provider if it exists.
 * @param user
 * @param provider
 * @returns {null}
 */
userController.getExternalAccountAccessToken = function(user, provider) {
    var externalAccounts = user.externalAccounts;
    for (var i = 0; i < externalAccounts.length; i++) {
        if (externalAccounts[i].provider == provider) {
            var securityHelper = require('../auth/security.helper');
            return securityHelper.decrypt(externalAccounts[i].access_token, appVars.accessTokenKey, externalAccounts[i].at_iv, externalAccounts[i].at_tag);
        }
    }
    return null;
};

/**
 * Continually generates a new random id until an unused one is found.
 * @returns {Promise}
 */
function generateId() {
    return new Promise(function (resolve, reject) {
        var generateAttempt = function () {
            var id = "";
            var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

            for( var i = 0; i < 10; i++ ) {
                id += possible.charAt(Math.floor(Math.random() * possible.length));
            }

            userController.getUserByID(id)
                .then(function (user) {
                    if(!user) {
                        resolve(id);
                    }
                    else {
                        generateAttempt();
                    }
                }, function (error) {
                    reject(error);
                })
        };
        generateAttempt();
    });
}

/**
 * Merges the two given ids into one.
 * @param id1
 * @param id2
 * @returns {Promise}
 */
function mergeIds(id1, id2) {
    return new Promise(function (resolve, reject) {
        var pool = appVars.pool;
        pool.connect(function (err, client, done) {
            if (err) {
                return console.error('error fetching client from pool', err);
            }
            client.query("UPDATE external_auth SET user_id=$1 WHERE user_id = $2;", [id1, id2]);
            client.query("DELETE FROM users WHERE id=$1;", [id2],
                function (err) {
                    done(err);
                    if (err) reject(err);
                    userController.getUserByID(id1)
                        .then(function (user) {
                            resolve(user);
                        }, function (error) {
                            reject(error);
                        });
                }
            );
        });
    })
}

module.exports = userController;