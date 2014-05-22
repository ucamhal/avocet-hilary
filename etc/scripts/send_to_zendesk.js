/*!
 * Copyright 2014 Digital Services, University of Cambridge Licensed
 * under the Educational Community License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the
 * License. You may obtain a copy of the License at
 *
 *     http://opensource.org/licenses/ECL-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an "AS IS"
 * BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

/*
 * The following is a crude script to force-sync tickets that are in OAE
 * but not in ZenDesk. Do *NOT* use this script lightly as it probably
 * doesn't do what you think it does
 */

var _ = require('underscore');
var NodeZendesk = require('node-zendesk');
var optimist = require('optimist');
var path = require('path')
var util = require('util');

var Cassandra = require('oae-util/lib/cassandra');
var ContentDAO = require('oae-content/lib/internal/dao.content');
var OAE = require('oae-util/lib/oae');
var PrincipalsDAO = require('oae-principals/lib/internal/dao');
var PublicationsDAO = require('oae-publications/lib/internal/dao');
var Redis = require('oae-util/lib/redis');
var TicketsDAO = require('oae-tickets/lib/internal/dao');

var argv = optimist.usage('$0 --email <email> --token <token> --uri <uri> --ticket <ticket>')
    .alias('e', 'email')
    .describe('e', 'The Zendesk email')
    .default('e', '')

    .alias('t', 'token')
    .describe('t', 'The Zendesk token')
    .default('t', '')

    .alias('u', 'uri')
    .describe('u', 'The Zendesk uri')
    .default('u', '')

    .alias('i', 'ticket')
    .describe('i', 'The OA ticket')
    .default('i', '')

    .alias('h', 'help')
    .describe('h', 'Show usage information')
    .argv;

if (!argv.email || !argv.token || !argv.uri || !argv.ticket) {
    console.error('The email, token, uri and ticket are all required parameters');
    return;
}



var config = require(path.resolve('config')).config;

// Stub the servers
OAE.globalAdminServer = {'use': function(){}};
OAE.tenantServer = {'use': function(){}};


Cassandra.init(config.cassandra, function(err) {
    if (err) {
        console.error(err);
        return;
    }

    Redis.init(config.redis);

    var TenantsInit = require('oae-tenants/lib/init');
    TenantsInit(config, function(err) {
        if (err) {
            console.error(err);
            return;
        }

        TicketsDAO.getTicket(argv.ticket, function(err, ticket) {
            if (err) {
                console.error(err);
                console.error('Failed to get ticket');
                return;
            }
            //console.log(' - Got ticket data: %s', ticket.externalId);

            PublicationsDAO.getPublication(ticket.publicationId, function(err, publication) {
                if (err) {
                    console.error(err);
                    console.error('Failed to get publication');
                    return;
                }
                //console.log(' - Got publication data: %s - %s', publication.id, publication.displayName);

                ContentDAO.getContent(publication.linkedContentId, function(err, content) {
                    if (err) {
                        console.error(err);
                        console.error('Failed to get content');
                        return;
                    }

                    publication.linkedContent = content;

                    console.log('%s - https://www.openaccess.cam.ac.uk%s', ticket.externalId, publication.linkedContent.downloadPath)
                    process.exit();

                    client = _getZenDeskClient(argv.email, argv.token, argv.uri);
                    //createTicket(ticket, publication, principal);
                });
            });
        });  
    })
});


// The zendesk client
var client = null;

var createTicket = function(ticket, publication, user) {
    // Contact the submitter at the address provided in the form, or their account email if no address was provided.
    var userEmail = publication.contactEmail || user.email;

    // Retrieve the ZenDesk user
    _getOrCreateZendeskUser(client, user.displayName, userEmail, function(err, zenDeskUser) {
        if (err) {
            console.error(err);
            console.error('Error creating ZenDesk user');
            return;
        }

        // Produce a date string for the acceptance date if one is available
        var acceptanceDate = null;
        if (_.isNumber(publication.acceptanceDate)) {
            acceptanceDate = _formatAcceptanceDate(publication.acceptanceDate);
        }

        // Construct the download URL for the attached content (if it exists)
        var downloadURL = null;
        if (publication.linkedContent && publication.linkedContent.downloadPath) {
            downloadURL = util.format('https://www.openaccess.cam.ac.uk%s', publication.linkedContent.downloadPath);
        }

        // Create an object that will be passed in when creating the ZenDesk ticket
        var zenDeskTicket = {
            'ticket': {
                'group_id': 1,
                'requester_id': zenDeskUser.id,
                'external_id': ticket.externalId,
                'subject': util.format('Open Access enquiry %s', ticket.externalId),
                'description': zendeskTicketBodyTemplate({
                    'user': user,
                    'publication': publication,
                    'email': userEmail,
                    'funders': _formatFunders(publication.funders),
                    'otherFunders': _getOtherFunders(publication.funders),
                    'ticket': ticket,
                    'groupID': 1,
                    'acceptanceDate': acceptanceDate
                })
            }
        };

        // Create a new ZenDesk ticket
        client.tickets.create(zenDeskTicket, function(err, req, result) {
            if (err) {
                console.error(err);
                console.error('Error creating ticket on ZenDesk.com');
                return;
            }

            // Create a private ticket that contains some data the user should not see
            var zenDeskComment = {
                'ticket': {
                    'comment': {
                        'body': zendeskTicketCommentBodyTemplate({
                            'user': user,
                            'downloadURL': downloadURL
                        }),
                        'public': false
                    }
                }
            };
            client.tickets.update(result.id, zenDeskComment, function(err) {
                if (err) {
                    console.error(err);
                    console.error('Error commenting on ticket');
                    return;
                }

                console.log('Done');
                process.exit();
            });
        });
    });
};

/**
 * Format a millisecond timestamp as dd/mm/yyyy for use in the ZenDesk ticket description.
 *
 * @param  {Number}     dateMillis      The timestamp to format
 * @return {String}                     A string representing the timestamp's value
 * @api private
 */
var _formatAcceptanceDate = function(dateMillis) {
    var date = new Date();
    date.setTime(dateMillis);

    return util.format('%d/%d/%d', date.getDate(), date.getMonth() + 1, date.getFullYear());
};

/**
 * Strip the 'other:' prefix from an "Other Funder" funder string.
 *
 * @param  {String}             funder      A funder string
 * @return {String|undefined}               The portion of the string after other:, or undefined if the string didn't start with other: or the string following other: was empty
 * @api private
 */
var _stripOtherFunderPrefix = function(funder) {
    if (funder.substr(0, 6) === 'other:' && funder.length > 6) {
        return funder.substr(6);
    }
    return undefined;
};

/**
 * Get the values of the 'other:' funders in a list of funders, joined with commas.
 *
 * @param  {String[]}           funders     An array of funder strings
 * @return {String|undefined}               The value of any 'Other' funders in the array
 * @api private
 */
var _getOtherFunders = function(funders) {
    return _.chain(funders).map(_stripOtherFunderPrefix).compact().value().join(', ') || undefined;
};

/**
 * Format a funder array for use in the ZenDesk ticket description.
 *
 * @param  {String[]}           funders     An array of funder strings
 * @return {String}                         A string representing the funder list
 * @api private
 */
var _formatFunders = function(funders) {
    return _.reject(funders, _stripOtherFunderPrefix).join(', ');
};

/**
 * Get the ZenDesk user for the specified email address, creating it if it doesn't already exist.
 * The name is not used to find users, but will be used when creating a user is necessary.
 *
 * @param  {Object}     client              A node-zendesk API client object
 * @param  {String}     name                The full name of the user
 * @param  {String}     email               The user's email
 * @param  {Function}   callback            Standard callback function
 * @param  {Object}     callback.err        Standard error object
 * @param  {Object}     callback.user       A Zendesk user object (no {'user': {...}} wrapper)
 * @api private
 */
var _getOrCreateZendeskUser = function(client, name, email, callback) {
    // If the querystring is an email, ZenDesk seems to only match users with the exact matching email address.
    client.users.search({'query': email}, function(err, status, data) {
        if (err) {
            console.error({'err': err, 'email': email}, 'Error while searching for ZenDesk user');
            return callback({'code': 500, 'err': 'Error while searching for ZenDesk user'});
        }

        // No need to create a user as one already exists
        if (!_.isEmpty(data)) {
            return callback(null, data[0]);
        }

        // Create user
        client.users.create({'user': {'name': name, 'email': email}}, function(err, status, data) {
            if (err) {
                console.error({'err': err, 'name': name, 'email': email}, 'Error while creating ZenDesk user');
                return callback({'code': 500, 'msg': 'Error while creating ZenDesk user'});
            }

            if (status !== 201) {
                console.error({'status': status, 'data': data}, 'Unexpected response from ZenDesk API, expected 201 created');
                return callback({'code': 500, 'msg': 'Unexpected response from ZenDesk API, expected 201 created'});
            }

            return callback(null, data);
        });
    });
};

/**
 * Create and return the ZenDesk client
 *
 * @param  {String}     email       The user's email
 * @param  {String}     token       The ZenDesk token
 * @param  {String}     uri         The ZenDesk uri
 * @return {Client}                 The ZenDesk client
 * @api private
 */
var _getZenDeskClient = function(email, token, uri) {
    return NodeZendesk.createClient({
        'username': email,
        'token': token,
        'remoteUri': uri
    });
};

/**
 * The template used to generate the ZenDesk ticket's description field.
 * This will be included in the email to the user who uploaded the publication.
 *
 * @api private
 */
var zendeskTicketBodyTemplate = module.exports.zendeskTicketBodyTemplate = _.template([
    'Open Access enquiry <%= ticket.externalId %> has been received by Cambridge University (https://www.openaccess.cam.ac.uk/).',
    '',
    'The information received was as follows:',
    '',
    'User information:',
    '  name: <%= user.displayName %>',
    '  department: <%= publication.department || \'(none provided)\' %>',
    '  email: <%= email || \'(none provided)\' %>',
    '',
    'Publishing information:',
    '  article title: <%= publication.displayName || \'(none provided)\' %>',
    '  journal title: <%= publication.journalName || \'(none provided)\' %>',
    '  funders: <%= funders || \'(none provided)\'%>',
    '  other funder(s): <%= otherFunders || \'(none provided)\'%>',
    '  corresponding author: <%= publication.authors || \'(none provided)\'%>',
    '  acceptance date: <%= acceptanceDate || \'(none provided)\' %>',
    '  use Cambridge Addendum?: <%= publication.useCambridgeAddendum || \'(none provided)\'%>',
    '  remarks:',
    '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
    '<%= publication.comments || \'(none provided)\'%>',
    '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛'
].join('\n'));

/**
 * The template used to generate the ZenDesk ticket's private comment body.
 *
 * @api private
 */
var zendeskTicketCommentBodyTemplate = module.exports.zendeskTicketCommentBodyTemplate = _.template([
    'Submitted file download link:',
    '  <%= downloadURL || \'(no file attached)\' %>',
    'For debugging purposes only:',
    '  The avocet internal user ID: <%= user.id %>',
].join('\n'));
