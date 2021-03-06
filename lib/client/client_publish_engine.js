"use strict";
require("requirish")._(module);
var _ = require("underscore");
var subscription_service = require("lib/services/subscription_service");
var assert = require("better-assert");

var debugLog = require("lib/misc/utils").make_debugLog(__filename);
//xx var debugLog = console.log;

/**
 * A client side implementation to deal with publish service.
 *
 * @class ClientSidePublishEngine
 *
 * @param session {ClientSession} - the client session
 * @param options {object} - the client session
 * @constructor
 *
 * The ClientSidePublishEngine encapsulates the mechanism to
 * deal with a OPCUA Server and constantly sending PublishRequest
 * The ClientSidePublishEngine also performs  notification acknowledgements.
 * Finally, ClientSidePublishEngine dispatch PublishResponse to the correct
 * Subscription id callback
 */
function ClientSidePublishEngine(session) {
    assert(session instanceof Object);

    this.session = session;

    this.subscriptionAcknowledgements = [];
    this.subscriptionIdFuncMap = {};

    this.timeoutHint = 10000; // 10 s by default

    this.activeSubscriptionCount = 0;

    // number of pending Publish request sent to the server and awaited for being processed by the server
    this.nbPendingPublishRequests = 0;

}


/**
 * @method acknowledge_notification
 * @param subscriptionId {Number} the subscription id
 * @param sequenceNumber {Number} the sequence number
 */
ClientSidePublishEngine.prototype.acknowledge_notification = function (subscriptionId, sequenceNumber) {
    this.subscriptionAcknowledgements.push({
        subscriptionId: subscriptionId,
        sequenceNumber: sequenceNumber
    });
};

ClientSidePublishEngine.prototype.cleanup_acknowledgment_for_subscription = function (subscriptionId) {

    this.subscriptionAcknowledgements = this.subscriptionAcknowledgements.filter(function (a) {
        return a.subscriptionId !== subscriptionId;
    });
};

/**
 * @method send_publish_request
 */
ClientSidePublishEngine.prototype.send_publish_request = function () {
    var self = this;
    setImmediate(function () {
        if (!self.session) {
            // session has been terminated
            return;
        }
        self._send_publish_request();
    });
};


ClientSidePublishEngine.prototype._send_publish_request = function () {

    debugLog("sending publish request".yellow);
    var self = this;
    assert(self.session, "ClientSidePublishEngine terminated ?");

    self.nbPendingPublishRequests +=1;

    var subscriptionAcknowledgements = self.subscriptionAcknowledgements;
    self.subscriptionAcknowledgements = [];

    // as started in the spec (Spec 1.02 part 4 page 81 5.13.2.2 Function DequeuePublishReq())
    // the server will dequeue the PublishRequest  in first-in first-out order
    // and will validate if the publish request is still valid by checking the timeoutHint in the RequestHeader.
    // If the request timed out, the server will send a Bad_Timeout service result for the request and de-queue
    // another publish request.
    //
    // in Part 4. page 144 Request Header the timeoutHint is described this way.
    // timeoutHint UInt32 This timeout in milliseconds is used in the Client side Communication Stack to
    //                    set the timeout on a per-call base.
    //                    For a Server this timeout is only a hint and can be used to cancel long running
    //                    operations to free resources. If the Server detects a timeout, he can cancel the
    //                    operation by sending the Service result Bad_Timeout. The Server should wait
    //                    at minimum the timeout after he received the request before cancelling the operation.
    //                    The value of 0 indicates no timeout.
    // In issue#40 (MonitoredItem on changed not fired), we have found that some server might wrongly interpret
    // the timeoutHint of the request header ( and will bang a Bad_Timeout regardless if client send timeoutHint=0)
    // as a work around here , we force the timeoutHint to be set to a suitable value.
    //
    // see https://github.com/node-opcua/node-opcua/issues/141
    // This suitable value shall be at least the time between two keep alive signal that the server will send.
    // (i.e revisedLifetimeCount * revisedPublishingInterval)

    // also ( part 3 - Release 1.03 page 140)
    // The Server shall check the timeoutHint parameter of a PublishRequest before processing a PublishResponse.
    // If the request timed out, a Bad_Timeout Service result is sent and another PublishRequest is used.
    // The value of 0 indicates no timeout

    // in our case:

    assert( self.nbPendingPublishRequests >0);
    var calculatedTimeout = self.nbPendingPublishRequests * self.timeoutHint;

    var publish_request = new subscription_service.PublishRequest({
        requestHeader: {timeoutHint: calculatedTimeout}, // see note
        subscriptionAcknowledgements: subscriptionAcknowledgements
    });
    self.session.publish(publish_request, function (err, response) {

        self.nbPendingPublishRequests -= 1;
        if (err) {
            debugLog("ClientSidePublishEngine.prototype._send_publish_request callback ".red, err.message.yellow);
        } else {
            debugLog("ClientSidePublishEngine.prototype._send_publish_request callback ".cyan);
            self._receive_publish_response(response);
        }

        // feed the server with a new publish Request to the server
        if (self.activeSubscriptionCount>0) {
            self.send_publish_request();
        }

    });
};

ClientSidePublishEngine.prototype.terminate = function () {
    this.session = null;
};


/**
 * the number of active subscriptions managed by this publish engine.
 * @property subscriptionCount
 * @type {Number}
 */
ClientSidePublishEngine.prototype.__defineGetter__("subscriptionCount", function () {
    var self = this;
    return Object.keys(self.subscriptionIdFuncMap).length;
});

ClientSidePublishEngine.publishRequestCountInPipeline = 5;

/**
 * @method registerSubscriptionCallback
 *
 * @param subscriptionId
 * @param timeoutHint
 * @param {Function} callback
 */
ClientSidePublishEngine.prototype.registerSubscriptionCallback = function (subscriptionId, timeoutHint, callback) {

    var self = this;
    assert(arguments.length === 3);
    assert(!self.subscriptionIdFuncMap.hasOwnProperty(subscriptionId)); // already registered ?
    assert(_.isFinite(timeoutHint));
    assert(_.isFunction(callback));

    self.activeSubscriptionCount += 1;
    self.subscriptionIdFuncMap[subscriptionId] = callback;

    self.timeoutHint = Math.max(self.timeoutHint,timeoutHint);


    debugLog(" SETTING TIMEOUT HINT ".bgWhite.red,self.timeoutHint,timeoutHint);

    // Spec 1.03 part 4 5.13.5 Publish
    // [..] in high latency networks, the Client may wish to pipeline Publish requests
    // to ensure cyclic reporting from the Server. Pipelining involves sending more than one Publish
    // request for each Subscription before receiving a response. For example, if the network introduces a
    // delay between the Client and the Server of 5 seconds and the publishing interval for a Subscription
    // is one second, then the Client will have to issue Publish requests every second instead of waiting for
    // a response to be received before sending the next request.
    self.send_publish_request();

    // send more than one publish request to server to cope with latency
    for (var i = 0; i < ClientSidePublishEngine.publishRequestCountInPipeline - 1; i++) {
        self.send_publish_request();
    }
};
/**
 * @method unregisterSubscriptionCallback
 *
 * @param subscriptionId
 */
ClientSidePublishEngine.prototype.unregisterSubscriptionCallback = function (subscriptionId) {
    var self = this;
    if (subscriptionId === "pending") {
        console.log("special subscriptionId here");
    }
    self.activeSubscriptionCount -= 1;
    assert(self.subscriptionIdFuncMap.hasOwnProperty(subscriptionId));
    delete self.subscriptionIdFuncMap[subscriptionId];
};

ClientSidePublishEngine.prototype._receive_publish_response = function (response) {

    debugLog("receive publish response".yellow.bold);
    var self = this;

    // the id of the subscription sending the notification message
    var subscriptionId = response.subscriptionId;

    // the sequence numbers available in this subscription
    // for retransmission and not acknowledged by the client
    // -- var available_seq = response.availableSequenceNumbers;

    // has the server more notification for us ?
    // -- var moreNotifications = response.moreNotifications;

    var notificationMessage = response.notificationMessage;
    //  notificationMessage.sequenceNumber
    //  notificationMessage.publishTime
    //  notificationMessage.notificationData[]

    notificationMessage.notificationData = notificationMessage.notificationData || [];

    if (notificationMessage.notificationData.length !== 0) {
        self.acknowledge_notification(subscriptionId, notificationMessage.sequenceNumber);
    }
    //else {
    // this is a keep-alive notification
    // in this case , we shall not acknowledge notificationMessage.sequenceNumber
    // which is only an information of what will be the future sequenceNumber.
    //}

    var callback_for_subscription = self.subscriptionIdFuncMap[subscriptionId];

    if (callback_for_subscription && self.session !== null) {

        // delegate notificationData to the subscription callback
        callback_for_subscription(notificationMessage.notificationData, notificationMessage.publishTime);

    } else {
        debugLog(" ignoring notificationMessage", notificationMessage, " for subscription", subscriptionId);
        debugLog(" because there is no callback for the subscription.");
        debugLog(" or because there is no session for the subscription (session terminated ?).");
    }
};
exports.ClientSidePublishEngine = ClientSidePublishEngine;
